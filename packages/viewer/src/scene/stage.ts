// Renderer, true-isometric orthographic camera, daylight lighting, zoom/pan.
// WebGPU when available, WebGL2 otherwise (three/webgpu falls back on its own).

import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OFFICE } from '../layout/layout.ts';

export interface ScreenPoint {
  x: number;
  y: number;
}

export class Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly backend: Promise<'webgpu' | 'webgl2'>;
  private host: HTMLElement;
  private base = { halfW: 1, halfH: 1, center: new THREE.Vector3() };
  private pan = new THREE.Vector2();
  private width = 1;
  private height = 1;
  private v = new THREE.Vector3();
  onResize: (() => void) | null = null;
  /** Where the last press started, so a drag isn't mistaken for a click. */
  downAt = { x: 0, y: 0 };

  constructor(host: HTMLElement) {
    this.host = host;
    // Transparent canvas: the studio backdrop is a CSS gradient behind it (no full-screen pass).
    this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Neutral tone mapping keeps whites white and colors true: a daylight architectural model.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor('#000000', 0);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 200);
    this.setupCamera();
    this.setupLights();
    this.backend = this.renderer.init().then(() => {
      this.setupEnvironment();
      return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
    });

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.setupControls();
  }

  /** True isometric: looking down the (−1, −1, −1) diagonal, Y up. */
  private setupCamera() {
    const { w, d, wallHeight } = OFFICE.grid;
    const center = new THREE.Vector3(w / 2, wallHeight * 0.3, d / 2);
    this.camera.position.copy(center).add(new THREE.Vector3(30, 30, 30));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();
    // Fit the floor and wall tops.
    const pts = [
      [0, 0, 0],
      [w, 0, 0],
      [0, 0, d],
      [w, 0, d],
      [0, wallHeight, 0],
      [w, wallHeight, 0],
      [0, wallHeight, d],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 0.6;
    this.base.halfW = (Math.max(...xs) - Math.min(...xs)) / 2 + pad;
    this.base.halfH = (Math.max(...ys) - Math.min(...ys)) / 2 + pad;
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    // Shift the camera so the fitted box is centred.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(right, midX).addScaledVector(up, midY);
    this.base.center.copy(this.camera.position);
  }

  /**
   * Image-based light from a soft studio room, computed once: realistic shading on every
   * material for the cost of one prefiltered texture.
   */
  private setupEnvironment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
      this.scene.environment = env.texture;
      this.scene.environmentIntensity = 0.55;
      this.hemi.intensity = 0.75;
      pmrem.dispose();
    } catch {
      /* hemisphere light alone still looks fine */
    }
    this.invalidateShadows();
  }

  private hemi = new THREE.HemisphereLight('#ffffff', '#d8cbb3', 1.35);
  private sun = new THREE.DirectionalLight('#fff6ea', 2.2);
  quality: 'high' | 'low' = 'high';

  /** Shadows re-render only when something moved (not every frame). */
  invalidateShadows() {
    this.sun.shadow.needsUpdate = true;
  }

  /** Drop to a lighter tier on slow GPUs: native pixel ratio and a smaller shadow map. */
  setQuality(q: 'high' | 'low') {
    if (q === this.quality) return;
    this.quality = q;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    this.sun.shadow.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.resize();
    this.invalidateShadows();
  }

  private setupLights() {
    this.scene.add(this.hemi);
    // Warm "sun" through the window on the back wall.
    const sun = this.sun;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    sun.position.set(13, 16, -6);
    sun.target.position.set(9, 0, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -16;
    s.right = 16;
    s.top = 16;
    s.bottom = -16;
    s.near = 1;
    s.far = 60;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 6;
    sun.shadow.blurSamples = 12;
    this.scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#dfe9ff', 0.55);
    fill.position.set(30, 20, 25);
    this.scene.add(fill);
  }

  private applyView() {
    const aspect = this.width / this.height;
    let halfW = this.base.halfW;
    let halfH = this.base.halfH;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.base.center).addScaledVector(right, this.pan.x).addScaledVector(up, this.pan.y);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.applyView();
    this.invalidateShadows();
    this.onResize?.();
  }

  private setupControls() {
    const el = this.renderer.domElement;
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const z = THREE.MathUtils.clamp(this.camera.zoom * Math.exp(-e.deltaY * 0.0015), 0.8, 3.2);
        // Zoom toward the cursor.
        const r = el.getBoundingClientRect();
        const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
        const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
        const before = { x: (nx * (this.camera.right - this.camera.left)) / 2 / this.camera.zoom, y: (ny * (this.camera.top - this.camera.bottom)) / 2 / this.camera.zoom };
        this.camera.zoom = z;
        const after = { x: (nx * (this.camera.right - this.camera.left)) / 2 / z, y: (ny * (this.camera.top - this.camera.bottom)) / 2 / z };
        this.pan.x += before.x - after.x;
        this.pan.y += before.y - after.y;
        this.applyView();
        this.wheelAt = performance.now();
      },
      { passive: false },
    );
    let drag: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      this.dragging = true;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = el.getBoundingClientRect();
      const sx = (this.camera.right - this.camera.left) / this.camera.zoom / r.width;
      const sy = (this.camera.top - this.camera.bottom) / this.camera.zoom / r.height;
      this.pan.x -= (e.clientX - drag.x) * sx;
      this.pan.y += (e.clientY - drag.y) * sy;
      drag = { x: e.clientX, y: e.clientY };
      this.applyView();
    });
    el.addEventListener('pointerup', () => {
      drag = null;
      this.dragging = false;
    });
    el.addEventListener('pointerdown', (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    el.addEventListener('dblclick', () => this.resetView());
  }

  private anim: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; t: number } | null = null;

  resetView() {
    this.animateTo(0, 0, 1);
  }

  /** Ease the camera so a grid point (x, y on the floor, z up) is centered at the given zoom. */
  focusOn(x: number, y: number, z: number, zoom = 1.8) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const d = new THREE.Vector3(x, z, y).sub(this.base.center);
    this.animateTo(d.dot(right), d.dot(up), zoom);
  }

  /** Follow mode: keep a grid point centred every frame (no easing, zoom unchanged). */
  centerOn(x: number, y: number, z: number) {
    if (this.anim) return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const d = new THREE.Vector3(x, z, y).sub(this.base.center);
    const tx = d.dot(right);
    const ty = d.dot(up);
    // Gentle catch-up so walking reads smoothly.
    this.pan.set(this.pan.x + (tx - this.pan.x) * 0.15, this.pan.y + (ty - this.pan.y) * 0.15);
    this.applyView();
  }

  private animateTo(px: number, py: number, zoom: number) {
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (instant) {
      this.pan.set(px, py);
      this.camera.zoom = zoom;
      this.applyView();
      return;
    }
    this.anim = { from: { x: this.pan.x, y: this.pan.y, z: this.camera.zoom }, to: { x: px, y: py, z: zoom }, t: 0 };
  }

  /** Camera animating or the user dragging: render every frame. */
  get busy(): boolean {
    return this.anim !== null || this.dragging || performance.now() - this.wheelAt < 300;
  }
  dragging = false;
  wheelAt = 0;

  tick(dt: number) {
    if (!this.anim) return;
    const a = this.anim;
    a.t = Math.min(1, a.t + dt / 0.6);
    const k = 1 - Math.pow(1 - a.t, 3);
    this.pan.set(a.from.x + (a.to.x - a.from.x) * k, a.from.y + (a.to.y - a.from.y) * k);
    this.camera.zoom = a.from.z + (a.to.z - a.from.z) * k;
    this.applyView();
    if (a.t >= 1) this.anim = null;
  }

  /** Grid point under a client pixel is not needed; selection uses a raycast against people. */
  ndc(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * 2 - 1, y: -(((clientY - r.top) / r.height) * 2 - 1) };
  }

  /** Grid point (x, y on the floor, z up) → CSS pixels within the host. */
  project(x: number, y: number, z: number): ScreenPoint {
    this.v.set(x, z, y).project(this.camera);
    return { x: ((this.v.x + 1) / 2) * this.width, y: ((1 - this.v.y) / 2) * this.height };
  }

  projectWorld(p: THREE.Vector3): ScreenPoint {
    this.v.copy(p).project(this.camera);
    return { x: ((this.v.x + 1) / 2) * this.width, y: ((1 - this.v.y) / 2) * this.height };
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * CSS matrix that maps an element of size (w × h) px onto a wall-aligned plane. Orthographic
 * projection is affine, so three projected corners define it exactly.
 */
export function planeMatrix(o: ScreenPoint, u: ScreenPoint, v: ScreenPoint, w: number, h: number): string {
  const a = (u.x - o.x) / w;
  const b = (u.y - o.y) / w;
  const c = (v.x - o.x) / h;
  const d = (v.y - o.y) / h;
  return `matrix(${a}, ${b}, ${c}, ${d}, ${o.x}, ${o.y})`;
}
