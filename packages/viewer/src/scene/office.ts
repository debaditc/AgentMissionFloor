// The office floor (spec §6): walls, floor, rugs and every piece of furniture, built
// procedurally from office.json. No external assets; no text in the scene (labels are DOM).

import * as THREE from 'three/webgpu';
import { OFFICE, type Desk, type OfficeLayout } from '../layout/layout.ts';
import { box, canvasTexture, contactShadow, cylinder, mat, mergeStatic, rbox, rng, sphere } from './kit.ts';

const C = {
  floor: '#e8dcc6',
  plank: '#dccdb2',
  floorEdge: '#cdbd9f',
  wallBack: '#f3f4f6',
  wallLeft: '#e6e9ed',
  wallCap: '#c3c8ce',
  skirting: '#d5d8dc',
  deskTop: '#f4f2ee',
  deskLeg: '#23262b',
  chair: '#364252',
  monitor: '#23272e',
  keyboard: '#d7dbe0',
  wood: '#c8a57c',
  woodDark: '#c09a6e',
  woodTop: '#d4b38a',
  cabinet: '#8a929b',
  rack: '#2b2f36',
  bench: '#c9ccd1',
  sofa: '#ddd3c3',
  armchair: '#cfae95',
  pot: '#b46d48',
  leaf: '#5d9a45',
  leafLight: '#7cb85c',
  glass: '#cfe3ea',
  glassFrame: '#9fb2bd',
  bossDesk: '#6b4a33',
} as const;

/**
 * Natural, neutral accents (D22): muted sage, linen, oat, clay, stone and charcoal on white oak.
 * Modern and calm; nothing shouts except the amber "needs you".
 */
export const ACCENT = { sage: '#c3cdb9', lilac: '#ddd3c3', butter: '#e6dccb', peach: '#d8b9a3', sky: '#a9b8c2', mint: '#d6dccf', charcoal: '#3c3f44', walnut: '#9b7b5e' } as const;
const CHAIR_COLORS = [ACCENT.butter, ACCENT.charcoal, ACCENT.sage, ACCENT.walnut, ACCENT.lilac];
const POT_COLORS = ['#efe9df', '#cdb7a2', ACCENT.charcoal, '#b8c2ad', '#e6dccb'];
const BOOK_COLORS = [ACCENT.sage, '#e6dccb', ACCENT.walnut, '#b9a58c', '#7f8a7a', '#d8cfc2', '#55606e', '#efe9df'];

export interface OfficeScene {
  root: THREE.Group;
  /** Monitor meshes by desk id: lit while their owner is working. */
  screens: Map<string, THREE.Mesh>;
  deskGroups: Map<string, THREE.Group>;
  rackLeds: THREE.Mesh[];
  /** Grid points the DOM overlay anchors to. */
  anchors: { board: { x0: number; x1: number; z0: number; z1: number }; glassLabel: { x0: number; x1: number; y: number; z: number } };
}

let codeTexture: THREE.CanvasTexture | undefined;
let offTexture: THREE.CanvasTexture | undefined;

function screenTextures() {
  if (!codeTexture) {
    const r = rng(7);
    codeTexture = canvasTexture(128, 80, (g) => {
      g.fillStyle = '#1d2836';
      g.fillRect(0, 0, 128, 80);
      const colors = ['#f2c46d', '#7fb3ff', '#c3d0e0', '#9ad19a'];
      for (let i = 0; i < 9; i++) {
        g.fillStyle = colors[Math.floor(r() * colors.length)]!;
        const indent = 8 + Math.floor(r() * 3) * 10;
        g.fillRect(indent, 7 + i * 7.6, 20 + r() * 70, 3);
      }
    });
    offTexture = canvasTexture(8, 8, (g) => {
      g.fillStyle = '#20252c';
      g.fillRect(0, 0, 8, 8);
    });
  }
  return { on: codeTexture, off: offTexture! };
}

function floor(root: THREE.Group, L: OfficeLayout) {
  const { w, d } = L.grid;
  // Oak planks: per-plank tone variation, fine grain and staggered joints, all procedural.
  const W = 2048;
  const H = Math.round((W * d) / w);
  const r = rng(3);
  const tex = canvasTexture(W, H, (g) => {
    const plankH = H / (d / 0.42);
    // Pale white-oak: under neutral tone mapping + image light, warmer tones read orange.
    const tones = ['#ece4d6', '#e8dfcf', '#efe8db', '#e5dbca', '#eae1d2'];
    for (let row = 0; row * plankH < H; row++) {
      let x = -((row * 337) % 620);
      while (x < W) {
        const len = 520 + r() * 380;
        g.fillStyle = tones[Math.floor(r() * tones.length)]!;
        g.fillRect(x, row * plankH, len, plankH);
        // Grain: long, faint, slightly wavy strokes.
        g.globalAlpha = 0.07;
        g.strokeStyle = '#8a6a43';
        g.lineWidth = 1;
        for (let k = 0; k < 7; k++) {
          const gy = row * plankH + r() * plankH;
          g.beginPath();
          g.moveTo(x, gy);
          g.bezierCurveTo(x + len * 0.3, gy + (r() - 0.5) * 6, x + len * 0.7, gy + (r() - 0.5) * 6, x + len, gy + (r() - 0.5) * 4);
          g.stroke();
        }
        g.globalAlpha = 1;
        g.fillStyle = 'rgba(120, 92, 58, 0.22)';
        g.fillRect(x, row * plankH, 1.5, plankH);
        x += len;
      }
      g.fillStyle = 'rgba(120, 92, 58, 0.18)';
      g.fillRect(0, row * plankH, W, 1.2);
    }
  });
  const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.72, metalness: 0 }));
  top.rotation.x = -Math.PI / 2;
  top.position.set(w / 2, 0, d / 2);
  top.receiveShadow = true;
  root.add(top);
  root.add(box(0, 0, w, d, 0.16, C.floorEdge, -0.161, false));

  // Late-morning sun falling through the window onto the floor (a soft warm patch, no glow).
  const Wn = L.window;
  const patchTex = canvasTexture(256, 256, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255, 236, 196, 0.0)');
    grad.addColorStop(0.18, 'rgba(255, 236, 196, 0.9)');
    grad.addColorStop(1, 'rgba(255, 236, 196, 0.0)');
    g.fillStyle = grad;
    g.fillRect(24, 0, 208, 256);
    g.globalCompositeOperation = 'destination-in';
    const side = g.createLinearGradient(0, 0, 256, 0);
    side.addColorStop(0, 'rgba(0,0,0,0)');
    side.addColorStop(0.15, 'rgba(0,0,0,1)');
    side.addColorStop(0.85, 'rgba(0,0,0,1)');
    side.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = side;
    g.fillRect(0, 0, 256, 256);
  });
  const patch = new THREE.Mesh(
    new THREE.PlaneGeometry(Wn.x1 - Wn.x0 + 0.6, 3.2),
    new THREE.MeshBasicMaterial({ map: patchTex, transparent: true, opacity: 0.42, depthWrite: false }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.set((Wn.x0 + Wn.x1) / 2 + 0.5, 0.004, 1.9);
  patch.renderOrder = -1;
  root.add(patch);
}

function walls(root: THREE.Group, L: OfficeLayout) {
  const { w, d, wallHeight: h } = L.grid;
  const t = 0.12;
  root.add(box(0, -t, w, t, h, C.wallBack, 0, false));
  root.add(box(-t, -t, t, d + t, h, C.wallLeft, 0, false));
  root.add(box(-t - 0.02, -t - 0.02, w + t + 0.02, t + 0.02, 0.06, C.wallCap, h, false));
  root.add(box(-t - 0.02, -t, t + 0.02, d + t, 0.06, C.wallCap, h, false));
  root.add(box(0, -0.02, w, 0.04, 0.12, C.skirting, 0, false));
  root.add(box(-0.02, 0, 0.04, d, 0.12, C.skirting, 0, false));
  // Two-tone walls: a soft sage lower band, the modern-office signature.
  root.add(box(0, -0.015, w, 0.02, 0.95, '#d6dccf', 0, false));
  root.add(box(-0.015, 0, 0.02, d, 0.95, '#dde2d6', 0, false));
  root.add(box(0, -0.012, w, 0.024, 0.03, '#c3cbbd', 0.95, false));
  root.add(box(-0.012, 0, 0.024, d, 0.03, '#c3cbbd', 0.95, false));
  // Arched art on the left wall above the lounge, and a pair of framed prints by the window.
  root.add(arch(0.02, 11.0, 1.1, 1.4, 1.35, ACCENT.peach));
  root.add(arch(0.03, 11.25, 0.6, 0.85, 1.55, ACCENT.butter));
  for (const [x, c1, c2] of [
    [12.3, ACCENT.lilac, ACCENT.butter],
    [17.7, ACCENT.sky, ACCENT.peach],
  ] as const) {
    root.add(box(x, 0.0, 0.9, 0.03, 1.15, '#f7f5f0', 1.45, false));
    root.add(box(x + 0.08, 0.025, 0.74, 0.01, 0.99, c1, 1.53, false));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 32), mat(c2));
    dot.position.set(x + 0.45, 2.02, 0.04);
    root.add(dot);
  }
}

/** A flat arch (rounded top) on the left wall x≈0, spanning grid y0..y0+w, from z0 up h. */
function arch(x: number, y0: number, w: number, h: number, z0: number, color: string): THREE.Mesh {
  const r = w / 2;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(-r, h - r);
  s.absarc(0, h - r, r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.lineTo(-r, 0);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(s, 24), mat(color, { roughness: 0.9 }));
  m.rotation.y = Math.PI / 2;
  m.position.set(x, z0, y0 + r);
  return m;
}

function rugs(root: THREE.Group, L: OfficeLayout) {
  for (const r of L.rugs) {
    if (r.zone === 'lounge') {
      // Round woven jute rug.
      const tex = canvasTexture(256, 256, (g) => {
        g.fillStyle = '#dccbb0';
        g.fillRect(0, 0, 256, 256);
        g.strokeStyle = 'rgba(140, 112, 76, 0.28)';
        for (let k = 0; k < 256; k += 6) {
          g.beginPath();
          g.arc(128, 128, k / 2, 0, Math.PI * 2);
          g.stroke();
        }
      });
      const rug = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
      rug.rotation.x = -Math.PI / 2;
      rug.scale.set(r.w / 2, r.d / 2, 1);
      rug.position.set(r.x + r.w / 2, 0.006, r.y + r.d / 2);
      rug.receiveShadow = true;
      root.add(rug);
      continue;
    }
    if (r.zone === 'boss') {
      // Terrazzo: warm white with pastel chips.
      const rr = rng(21);
      const tex = canvasTexture(512, 512, (g) => {
        g.fillStyle = '#f3efe9';
        g.fillRect(0, 0, 512, 512);
        const chips = ['#c9bfb3', '#a9a39b', '#d8b9a3', '#8d9188', '#e2dbd1'];
        for (let k = 0; k < 420; k++) {
          g.fillStyle = chips[k % chips.length]!;
          g.beginPath();
          g.ellipse(rr() * 512, rr() * 512, 2 + rr() * 6, 1.5 + rr() * 4, rr() * Math.PI, 0, Math.PI * 2);
          g.fill();
        }
      });
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 1.4);
      const floorTile = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 }));
      floorTile.rotation.x = -Math.PI / 2;
      floorTile.position.set(r.x + r.w / 2, 0.005, r.y + r.d / 2);
      floorTile.receiveShadow = true;
      root.add(floorTile);
      continue;
    }
    root.add(rbox(r.x, r.y, r.w, r.d, 0.012, mat(r.color, { roughness: 1 }), 0.001, 0.006, false));
  }
}

function chair(x: number, y: number, facing: 'n' | 's' = 'n', color: string = C.chair): THREE.Group {
  const g = new THREE.Group();
  g.add(cylinder(x, y, 0.04, 0.32, C.deskLeg));
  g.add(rbox(x - 0.24, y - 0.22, 0.48, 0.44, 0.08, mat(color, { roughness: 0.9 }), 0.32, 0.04));
  // Back is on the far side from what the sitter faces.
  const by = facing === 'n' ? y + 0.18 : y - 0.26;
  g.add(rbox(x - 0.24, by, 0.48, 0.08, 0.52, mat(color, { roughness: 0.9 }), 0.39, 0.035));
  g.add(cylinder(x, y, 0.2, 0.03, '#2a2f37', 0.02, 5));
  g.add(contactShadow(x - 0.25, y - 0.25, 0.5, 0.5));
  return g;
}

function desk(D: Desk, owned = true): THREE.Group {
  const g = new THREE.Group();
  const h = 0.56;
  g.add(rbox(D.x, D.y, D.w, D.d, 0.05, mat(C.deskTop, { roughness: 0.55 }), h, 0.02));
  g.add(contactShadow(D.x, D.y, D.w, D.d));
  for (const [lx, ly] of [
    [D.x + 0.06, D.y + 0.06],
    [D.x + D.w - 0.1, D.y + 0.06],
    [D.x + 0.06, D.y + D.d - 0.1],
    [D.x + D.w - 0.1, D.y + D.d - 0.1],
  ] as const)
    g.add(box(lx, ly, 0.04, 0.04, h, mat(C.deskLeg, { metalness: 0.6, roughness: 0.35 })));
  const cx = D.chair[0];
  // Monitor faces the chair (toward +y).
  g.add(box(cx - 0.05, D.y + 0.22, 0.1, 0.08, 0.16, C.monitor, h + 0.05));
  g.add(rbox(cx - 0.42, D.y + 0.16, 0.84, 0.05, 0.5, mat(C.monitor, { roughness: 0.4, metalness: 0.3 }), h + 0.2, 0.02));
  g.add(rbox(cx - 0.3, D.y + 0.48, 0.6, 0.18, 0.025, C.keyboard, h + 0.05, 0.01));
  g.add(cylinder(D.x + D.w - 0.3, D.y + 0.5, 0.05, 0.11, '#ffffff', h + 0.05, 10));
  if (owned) g.add(chair(cx, D.chair[1] - 0.05, 'n', CHAIR_COLORS[Math.abs(Math.round(D.x * 7 + D.y * 3)) % CHAIR_COLORS.length]));
  return g;
}

function screen(D: Desk): THREE.Mesh {
  const { off } = screenTextures();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.76, 0.42), new THREE.MeshBasicMaterial({ map: off }));
  m.position.set(D.chair[0], 0.56 + 0.2 + 0.25, D.y + 0.16 + 0.051);
  m.userData.dynamic = true;
  return m;
}

function bookshelf(root: THREE.Group, y0: number, y1: number, seed: number) {
  const x0 = 0.1;
  const depth = 0.65;
  const h = 2.3;
  root.add(rbox(x0, y0, depth, y1 - y0, h, mat(C.woodDark, { roughness: 0.7 }), 0, 0.03));
  root.add(contactShadow(x0, y0, depth, y1 - y0));
  const r = rng(seed);
  const rows = 4;
  for (let i = 0; i < rows; i++) {
    const z = 0.2 + i * 0.52;
    root.add(box(x0 + depth - 0.02, y0, 0.03, y1 - y0, 0.04, C.woodTop, z - 0.04, false));
    let y = y0 + 0.08;
    while (y < y1 - 0.15) {
      const t = 0.07 + r() * 0.07;
      const bh = 0.3 + r() * 0.14;
      if (r() > 0.08) root.add(box(x0 + depth - 0.28, y, 0.27, t - 0.01, bh, BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)]!, z, false));
      y += t;
    }
  }
}

function plant(root: THREE.Group, x: number, y: number, s = 1) {
  const potColor = POT_COLORS[Math.abs(Math.round(x * 5 + y * 11)) % POT_COLORS.length]!;
  root.add(cylinder(x, y, 0.2 * s, 0.42 * s, potColor, 0, 20));
  root.add(contactShadow(x - 0.2, y - 0.2, 0.4, 0.4));
  // A loose cluster of leaf masses, slightly different per plant.
  const r = rng(Math.round(x * 97 + y * 13));
  const leaves = [C.leaf, C.leafLight, '#4e8a3b', '#6aa84f'];
  for (let k = 0; k < 6; k++) {
    const a = r() * Math.PI * 2;
    const rad = 0.08 + r() * 0.12;
    const m = sphere(x + Math.cos(a) * rad * s, y + Math.sin(a) * rad * s, (0.55 + r() * 0.35) * s, (0.14 + r() * 0.1) * s, leaves[k % leaves.length]!);
    root.add(m);
  }
}

export function buildOffice(L: OfficeLayout = OFFICE): OfficeScene {
  const root = new THREE.Group();
  floor(root, L);
  walls(root, L);
  rugs(root, L);

  // Mission board (cards are DOM, projected onto this plane).
  const B = L.board;
  root.add(box(B.x0 - 0.06, 0.005, B.x1 - B.x0 + 0.12, 0.05, B.z1 - B.z0 + 0.12, '#9aa3ad', B.z0 - 0.06, false));
  root.add(box(B.x0, 0.03, B.x1 - B.x0, 0.04, B.z1 - B.z0, '#fbfbf8', B.z0, false));
  for (const f of [1 / 3, 2 / 3]) root.add(box(B.x0 + (B.x1 - B.x0) * f - 0.01, 0.06, 0.02, 0.02, B.z1 - B.z0 - 0.3, '#d3d7dc', B.z0 + 0.08, false));

  // Window with sky.
  const W = L.window;
  const sky = canvasTexture(64, 64, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#9fd3f2');
    grad.addColorStop(1, '#d9effa');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#8fb98a';
    g.beginPath();
    g.ellipse(14, 62, 18, 9, 0, 0, Math.PI * 2);
    g.ellipse(44, 64, 24, 10, 0, 0, Math.PI * 2);
    g.fill();
  });
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(W.x1 - W.x0, W.z1 - W.z0), new THREE.MeshBasicMaterial({ map: sky }));
  pane.position.set((W.x0 + W.x1) / 2, (W.z0 + W.z1) / 2, 0.012);
  root.add(pane);
  for (const [x, z, w, h] of [
    [W.x0 - 0.06, W.z0 - 0.06, W.x1 - W.x0 + 0.12, 0.08],
    [W.x0 - 0.06, W.z1 - 0.02, W.x1 - W.x0 + 0.12, 0.08],
    [W.x0 - 0.06, W.z0, 0.08, W.z1 - W.z0],
    [W.x1 - 0.02, W.z0, 0.08, W.z1 - W.z0],
    [(W.x0 + W.x1) / 2 - 0.03, W.z0, 0.06, W.z1 - W.z0],
  ] as const)
    root.add(box(x, 0, w, 0.07, h, '#a7b3bf', z, false));

  // Library: shelves, armchair. Archive: filing cabinets.
  L.shelves.forEach((s, i) => bookshelf(root, s.y0, s.y1, 11 + i));
  const A = L.armchair;
  const fabric = mat(C.armchair, { roughness: 0.95 });
  root.add(contactShadow(A.x - 0.42, A.y - 0.42, 0.84, 0.84));
  root.add(rbox(A.x - 0.36, A.y - 0.36, 0.72, 0.72, 0.36, fabric, 0, 0.08));
  root.add(rbox(A.x - 0.42, A.y - 0.38, 0.16, 0.76, 0.82, fabric, 0, 0.07));
  root.add(rbox(A.x - 0.36, A.y - 0.42, 0.72, 0.14, 0.56, fabric, 0, 0.06));
  root.add(rbox(A.x - 0.36, A.y + 0.28, 0.72, 0.14, 0.56, fabric, 0, 0.06));
  for (const a of L.archive) {
    root.add(rbox(0.1, a.y0 + 0.02, 0.7, a.y1 - a.y0 - 0.04, 1.25, mat(C.cabinet, { roughness: 0.45, metalness: 0.35 }), 0, 0.03));
    root.add(contactShadow(0.1, a.y0, 0.7, a.y1 - a.y0));
    for (const z of [0.3, 0.68, 1.06]) root.add(box(0.8, (a.y0 + a.y1) / 2 - 0.12, 0.02, 0.24, 0.035, '#5b6570', z, false));
  }

  // Server room.
  const leds: THREE.Mesh[] = [];
  L.racks.forEach((r, i) => {
    root.add(rbox(r.x0, 0.12, r.x1 - r.x0, 0.85, 2.2, mat(C.rack, { roughness: 0.4, metalness: 0.4 }), 0, 0.03));
    root.add(contactShadow(r.x0, 0.12, r.x1 - r.x0, 0.85));
    const lr = rng(31 + i);
    for (let row = 0; row < 7; row++) {
      const z = 0.3 + row * 0.27;
      root.add(box(r.x0 + 0.08, 0.97, r.x1 - r.x0 - 0.16, 0.01, 0.18, '#3a3f47', z, false));
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.01), new THREE.MeshBasicMaterial({ color: lr() > 0.3 ? '#56c271' : '#f2c46d' }));
      led.position.set(r.x1 - 0.18, z + 0.09, 0.985);
      led.userData.dynamic = true;
      root.add(led);
      leds.push(led);
    }
  });

  // Test lab bench with scope and monitor.
  const Bn = L.bench;
  root.add(rbox(Bn.x, Bn.y, Bn.w, Bn.d, 0.05, mat(C.bench, { roughness: 0.5 }), 0.62, 0.02));
  root.add(contactShadow(Bn.x, Bn.y, Bn.w, Bn.d));
  for (const [lx, ly] of [
    [Bn.x + 0.05, Bn.y + 0.05],
    [Bn.x + Bn.w - 0.1, Bn.y + 0.05],
    [Bn.x + 0.05, Bn.y + Bn.d - 0.1],
    [Bn.x + Bn.w - 0.1, Bn.y + Bn.d - 0.1],
  ] as const)
    root.add(box(lx, ly, 0.05, 0.05, 0.62, C.deskLeg));
  root.add(box(Bn.x + 0.4, Bn.y + 0.15, 0.7, 0.45, 0.4, '#3a3f46', 0.67));
  root.add(box(Bn.x + 0.5, Bn.y + 0.6, 0.5, 0.01, 0.26, '#2a6f5f', 0.74, false));
  root.add(box(Bn.x + 2.0, Bn.y + 0.2, 0.9, 0.06, 0.55, C.monitor, 0.72));
  root.add(box(Bn.x + 3.2, Bn.y + 0.3, 0.45, 0.35, 0.22, '#e07b00', 0.67));

  // Planning whiteboard on legs, facing +y.
  const Wb = L.whiteboard;
  root.add(box(Wb.x0, Wb.y - 0.03, Wb.x1 - Wb.x0, 0.06, 1.15, '#ffffff', 0.8));
  root.add(box(Wb.x0 - 0.04, Wb.y - 0.04, Wb.x1 - Wb.x0 + 0.08, 0.05, 0.05, '#9aa3ad', 1.95, false));
  for (const lx of [Wb.x0 + 0.05, Wb.x1 - 0.1]) root.add(box(lx, Wb.y - 0.04, 0.05, 0.08, 1.95, '#7d8187'));
  const marks: Array<[number, number, number, string]> = [
    [0.2, 1.65, 0.8, '#1f6feb'],
    [0.25, 1.45, 0.5, '#b4329f'],
    [0.2, 1.2, 1.2, '#4a5466'],
    [1.5, 1.05, 0.7, '#e07b00'],
  ];
  for (const [ox, z, w, c] of marks) root.add(box(Wb.x0 + ox, Wb.y + 0.03, w, 0.005, 0.03, c, z, false));

  // Lounge.
  const S = L.lounge.sofa;
  const sofa = mat(C.sofa, { roughness: 0.95 });
  root.add(contactShadow(S.x - 0.05, S.y - 0.05, S.w + 0.1, S.d + 0.1));
  root.add(rbox(S.x, S.y, S.w, S.d, 0.38, sofa, 0, 0.08));
  root.add(rbox(S.x - 0.05, S.y, 0.3, S.d, 0.86, sofa, 0, 0.09));
  root.add(rbox(S.x, S.y - 0.05, S.w, 0.24, 0.6, sofa, 0, 0.08));
  root.add(rbox(S.x, S.y + S.d - 0.19, S.w, 0.24, 0.6, sofa, 0, 0.08));
  for (const cy of [S.y + 0.25, S.y + S.d / 2 + 0.02]) root.add(rbox(S.x + 0.22, cy, S.w - 0.26, S.d / 2 - 0.3, 0.1, mat('#d9cff0', { roughness: 1 }), 0.38, 0.05));
  // Café corner (D22): a coffee bar against the wall, two bistro tables to chat at, a floor lamp.
  const K = L.lounge.coffee;
  root.add(contactShadow(K.x, K.y, K.w, K.d));
  root.add(rbox(K.x, K.y, K.w, K.d, 0.95, mat('#efe9df', { roughness: 0.7 }), 0, 0.03));
  root.add(rbox(K.x - 0.02, K.y - 0.02, K.w + 0.06, K.d + 0.04, 0.05, mat(C.woodTop, { roughness: 0.5 }), 0.95, 0.015));
  // Espresso machine: steel body, charcoal front, two group heads; a grinder and a stack of cups.
  root.add(rbox(K.x + 0.08, K.y + 0.12, 0.48, 0.5, 0.42, mat('#c9ccd0', { roughness: 0.25, metalness: 0.8 }), 1.0, 0.03));
  root.add(rbox(K.x + 0.5, K.y + 0.16, 0.08, 0.42, 0.3, mat(ACCENT.charcoal, { roughness: 0.4 }), 1.04, 0.02));
  for (const gy of [K.y + 0.26, K.y + 0.46]) root.add(cylinder(K.x + 0.62, gy, 0.035, 0.05, '#2a2c30', 1.1, 10));
  root.add(cylinder(K.x + 0.3, K.y + 0.85, 0.09, 0.32, ACCENT.charcoal, 1.0, 14));
  root.add(cylinder(K.x + 0.3, K.y + 0.85, 0.07, 0.12, '#c9ccd0', 1.32, 14));
  for (let k = 0; k < 3; k++) root.add(cylinder(K.x + 0.5, K.y + 0.95, 0.045, 0.05, '#ffffff', 1.0 + k * 0.05, 10));
  for (const tb of L.lounge.tables) {
    root.add(contactShadow(tb.x - 0.3, tb.y - 0.3, 0.6, 0.6));
    root.add(cylinder(tb.x, tb.y, 0.22, 0.03, ACCENT.charcoal, 0.005, 20));
    root.add(cylinder(tb.x, tb.y, 0.035, 0.98, ACCENT.charcoal, 0, 10));
    root.add(cylinder(tb.x, tb.y, 0.34, 0.035, '#f1eee9', 0.98, 28));
    root.add(cylinder(tb.x - 0.1, tb.y + 0.05, 0.04, 0.07, '#ffffff', 1.015, 10));
    root.add(cylinder(tb.x + 0.11, tb.y - 0.06, 0.04, 0.07, '#ffffff', 1.015, 10));
  }
  root.add(cylinder(0.6, 12.55, 0.03, 1.1, '#e9e3d8', 0, 10));
  root.add(cylinder(0.6, 12.55, 0.16, 0.03, '#e9e3d8', 0, 16));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat('#efe9df', { roughness: 0.7 }));
  dome.position.set(0.6, 1.08, 12.55);
  dome.castShadow = true;
  root.add(dome);

  // Ping pong: exactly two idle people play; everyone else gets coffee (D22).
  const Pp = L.pingpong;
  root.add(contactShadow(Pp.x, Pp.y, Pp.w, Pp.d));
  root.add(rbox(Pp.x, Pp.y, Pp.w, Pp.d, 0.05, mat('#3f6b5a', { roughness: 0.55 }), 0.7, 0.02));
  root.add(box(Pp.x, Pp.y + Pp.d / 2 - 0.01, Pp.w, 0.02, 0.006, '#f4f1ea', 0.751, false));
  root.add(box(Pp.x + 0.02, Pp.y + 0.02, Pp.w - 0.04, 0.03, 0.006, '#f4f1ea', 0.751, false));
  root.add(box(Pp.x + 0.02, Pp.y + Pp.d - 0.05, Pp.w - 0.04, 0.03, 0.006, '#f4f1ea', 0.751, false));
  root.add(box(Pp.x + Pp.w / 2 - 0.01, Pp.y - 0.06, 0.02, Pp.d + 0.12, 0.16, mat('#f4f1ea', { opacity: 0.55, roughness: 0.9 }), 0.75, false));
  for (const [lx, ly] of [
    [Pp.x + 0.2, Pp.y + 0.15],
    [Pp.x + Pp.w - 0.25, Pp.y + 0.15],
    [Pp.x + 0.2, Pp.y + Pp.d - 0.2],
    [Pp.x + Pp.w - 0.25, Pp.y + Pp.d - 0.2],
  ] as const)
    root.add(box(lx, ly, 0.05, 0.05, 0.7, ACCENT.charcoal));
  const Q = L.lounge.cooler;
  root.add(contactShadow(Q.x - 0.2, Q.y - 0.2, 0.4, 0.4));
  root.add(rbox(Q.x - 0.2, Q.y - 0.2, 0.4, 0.4, 0.95, mat('#e9edf1', { roughness: 0.5 }), 0, 0.05));
  root.add(cylinder(Q.x, Q.y, 0.17, 0.42, '#8fc7e8', 0.95));

  // AI Orchestrator's office: glass back + left walls with a door gap.
  const Bo = L.boss;
  const glass = mat(C.glass, { opacity: 0.22, roughness: 0.08, metalness: 0.1 });
  const gh = 1.7;
  root.add(box(Bo.x0, Bo.y0 - 0.02, Bo.x1 - Bo.x0, 0.04, gh, glass, 0, false));
  root.add(box(Bo.x0 - 0.02, Bo.y0, 0.04, Bo.doorGap[0] - Bo.y0, gh, glass, 0, false));
  root.add(box(Bo.x0 - 0.02, Bo.doorGap[1], 0.04, Bo.y1 - Bo.doorGap[1], gh, glass, 0, false));
  for (const [x, y, w, d] of [
    [Bo.x0, Bo.y0 - 0.03, Bo.x1 - Bo.x0, 0.06],
    [Bo.x0 - 0.03, Bo.y0, 0.06, Bo.doorGap[0] - Bo.y0],
    [Bo.x0 - 0.03, Bo.doorGap[1], 0.06, Bo.y1 - Bo.doorGap[1]],
  ] as const) {
    root.add(box(x, y, w, d, 0.05, C.glassFrame, gh, false));
    root.add(box(x, y, w, d, 0.05, C.glassFrame, 0, false));
  }
  for (const y of [Bo.y0, Bo.doorGap[0], Bo.doorGap[1]]) root.add(box(Bo.x0 - 0.04, y - 0.04, 0.08, 0.08, gh + 0.05, C.glassFrame, 0, false));
  const Bd = Bo.desk;
  root.add(contactShadow(Bd.x, Bd.y, Bd.w, Bd.d));
  root.add(rbox(Bd.x, Bd.y, Bd.w, Bd.d, 0.62, mat(C.bossDesk, { roughness: 0.55 }), 0, 0.04));
  root.add(box(Bd.x + 1.1, Bd.y + 0.3, 0.75, 0.05, 0.45, C.monitor, 0.66));
  root.add(box(Bd.x + 0.25, Bd.y + 0.45, 0.42, 0.32, 0.06, '#c88a2a', 0.62, false));
  root.add(box(Bd.x + 0.28, Bd.y + 0.48, 0.36, 0.26, 0.03, '#ffffff', 0.68, false));
  root.add(chair(Bo.chair[0], Bo.chair[1], 'n'));

  for (const [px, py] of L.plants) plant(root, px, py);

  // Desks: the four base desks plus the lead desk are always there; overflow desks appear on demand.
  const screens = new Map<string, THREE.Mesh>();
  const deskGroups = new Map<string, THREE.Group>();
  // Bake the static office into a few draw calls; desks stay separate (overflow desks toggle).
  const merged = mergeStatic(root);
  const office = new THREE.Group();
  office.add(merged);
  for (const D of [L.leadDesk, ...L.desks]) {
    const raw = desk(D);
    const s = screen(D);
    raw.add(s);
    const g = mergeStatic(raw);
    g.visible = !D.overflow;
    office.add(g);
    screens.set(D.id, s);
    deskGroups.set(D.id, g);
  }

  return {
    root: office,
    screens,
    deskGroups,
    rackLeds: leds,
    anchors: { board: B, glassLabel: { x0: Bo.x0 + 0.4, x1: Bo.x1 - 0.4, y: Bo.y0, z: 1.25 } },
  };
}

export function setScreen(mesh: THREE.Mesh, on: boolean) {
  const { on: onTex, off } = screenTextures();
  const m = mesh.material as THREE.MeshBasicMaterial;
  const next = on ? onTex : off;
  if (m.map !== next) {
    m.map = next;
    m.needsUpdate = true;
  }
}
