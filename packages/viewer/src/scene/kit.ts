// Small helpers for procedural low-poly geometry in grid units (x, y on the floor, z up).
// Three.js world: X = grid x, Y = up, Z = grid y.

import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const materials = new Map<string, THREE.MeshStandardMaterial>();

export function mat(color: string, opts: { roughness?: number; metalness?: number; opacity?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${opts.roughness ?? 0.85}|${opts.metalness ?? 0}|${opts.opacity ?? 1}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.85, metalness: opts.metalness ?? 0 });
    if (opts.opacity !== undefined && opts.opacity < 1) {
      m.transparent = true;
      m.opacity = opts.opacity;
      m.depthWrite = false;
    }
    materials.set(key, m);
  }
  return m;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);

/** Axis-aligned box from grid min corner (x, y) with size (w, d) and height h, starting at z0. */
export function box(x: number, y: number, w: number, d: number, h: number, color: string | THREE.Material, z0 = 0, shadows = true): THREE.Mesh {
  const mesh = new THREE.Mesh(unitBox, typeof color === 'string' ? mat(color) : color);
  mesh.scale.set(w, h, d);
  mesh.position.set(x + w / 2, z0 + h / 2, y + d / 2);
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  return mesh;
}

export function cylinder(x: number, y: number, r: number, h: number, color: string, z0 = 0, segments = 16): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), mat(color));
  mesh.position.set(x, z0 + h / 2, y);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function sphere(x: number, y: number, z: number, r: number, color: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), mat(color, { roughness: 0.9 }));
  mesh.position.set(x, z, y);
  mesh.castShadow = true;
  return mesh;
}

/** Deterministic PRNG so the office looks the same on every load. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Like box(), with softly rounded edges (furniture reads as real objects, not blocks). */
export function rbox(x: number, y: number, w: number, d: number, h: number, color: string | THREE.Material, z0 = 0, radius = 0.04, shadows = true): THREE.Mesh {
  const r = Math.min(radius, w / 2.2, d / 2.2, h / 2.2);
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), typeof color === 'string' ? mat(color) : color);
  mesh.position.set(x + w / 2, z0 + h / 2, y + d / 2);
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  return mesh;
}

let contactTex: THREE.CanvasTexture | undefined;
let contactMat: THREE.MeshBasicMaterial | undefined;

/**
 * Soft contact shadow under an object footprint (a pre-blurred texture on the floor). It stands
 * in for ambient occlusion at zero per-frame cost.
 */
export function contactShadow(x: number, y: number, w: number, d: number, strength = 1): THREE.Mesh {
  if (!contactTex) {
    contactTex = canvasTexture(128, 128, (g) => {
      const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    });
    contactTex.colorSpace = THREE.NoColorSpace;
    contactMat = new THREE.MeshBasicMaterial({ color: '#2a2418', map: contactTex, transparent: true, opacity: 0.22, depthWrite: false });
  }
  const pad = 0.35;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w + pad * 2, d + pad * 2), contactMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x + w / 2, 0.003 + strength * 0.0001, y + d / 2);
  m.renderOrder = -1;
  m.userData.contact = true;
  return m;
}

/**
 * Bakes every static mesh under `root` into one mesh per material: hundreds of furniture parts
 * become a few dozen draw calls. Meshes flagged `userData.dynamic` are left alone.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean; order: number }>();
  const keep: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o === root) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Positions in the office are absolute (parents have identity transforms), so dynamic meshes
    // can be re-parented without moving.
    if (mesh.userData.dynamic) {
      keep.push(mesh);
      return;
    }
    const m = mesh.material as THREE.Material;
    let b = buckets.get(m);
    if (!b) buckets.set(m, (b = { geos: [], cast: false, receive: false, order: mesh.renderOrder }));
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((g.attributes.position!.count) * 2), 2));
    g.applyMatrix4(mesh.matrixWorld);
    b.geos.push(g);
    b.cast ||= mesh.castShadow;
    b.receive ||= mesh.receiveShadow;
  });
  const out = new THREE.Group();
  for (const [m, b] of buckets) {
    const merged = mergeGeometries(b.geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, m);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.renderOrder = b.order;
    out.add(mesh);
  }
  for (const k of keep) {
    k.removeFromParent();
    out.add(k);
  }
  return out;
}
