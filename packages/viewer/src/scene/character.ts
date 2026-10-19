// Simple, charming low-poly people (spec §7): rounded torso in shirt color, darker arms,
// dark trousers, round head with a hair cap, soft ground shadow. Procedural poses only.

import * as THREE from 'three/webgpu';
import { hashString } from '@agent-mission-floor/world';
import type { Placement } from '../placement.ts';
import type { Frame } from '../choreo.ts';
import type { PlayerPose } from './rally.ts';
import { mat } from './kit.ts';

const SKIN = ['#f1c7a5', '#e0ac85', '#c68d64', '#8d5a3b', '#f5d6c0', '#b97a56'];
const HAIR = ['#2d2420', '#5a3b28', '#a8742f', '#1c1c1c', '#c9a26b', '#7a4b2a', '#3b3b46'];
const TROUSERS = '#2f3542';

const FACE_ANGLE = { n: Math.PI, s: 0, e: Math.PI / 2, w: -Math.PI / 2 } as const;

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1))));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
}

export function tintColor(hex: string): string {
  return shade(hex, 1.45);
}

const geo = {
  torso: new THREE.CapsuleGeometry(0.17, 0.26, 6, 14),
  limb: new THREE.CapsuleGeometry(0.055, 0.26, 4, 8),
  leg: new THREE.CapsuleGeometry(0.07, 0.22, 4, 8),
  head: new THREE.SphereGeometry(0.15, 20, 14),
  hair: new THREE.SphereGeometry(0.158, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
  eye: new THREE.SphereGeometry(0.018, 8, 6),
  mug: new THREE.CylinderGeometry(0.045, 0.04, 0.09, 10),
  paper: new THREE.BoxGeometry(0.18, 0.01, 0.24),
  shadow: new THREE.CircleGeometry(0.3, 24),
  ring: new THREE.RingGeometry(0.3, 0.38, 32),
  select: new THREE.RingGeometry(0.42, 0.52, 40),
};

const shadowMat = new THREE.MeshBasicMaterial({ color: '#1d2433', transparent: true, opacity: 0.16, depthWrite: false });

export class Character {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private torso: THREE.Mesh;
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private thighL = new THREE.Group();
  private thighR = new THREE.Group();
  private shinL = new THREE.Group();
  private shinR = new THREE.Group();
  private mug: THREE.Mesh;
  private papers: THREE.Mesh;
  private paddle: THREE.Group;
  private play: PlayerPose | null = null;
  private talking = false;
  private target: Placement | null = null;
  private walking = false;
  private stride = 0;
  private wantAngle = 0;
  private placed = false;
  private phase: number;
  private color = '';
  private ring: THREE.Mesh;
  private selectRing: THREE.Mesh;
  private scale = 1;

  readonly key: string;
  private reducedMotion: () => boolean;

  constructor(key: string, reducedMotion: () => boolean) {
    this.key = key;
    this.reducedMotion = reducedMotion;
    const h = hashString(key);
    this.phase = (h % 1000) / 159;
    const skin = SKIN[h % SKIN.length]!;
    const hair = HAIR[(h >>> 4) % HAIR.length]!;

    const shadow = new THREE.Mesh(geo.shadow, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.004;
    // Team-colored ground ring: findable from across the room. A second ring marks the selection.
    this.ring = new THREE.Mesh(geo.ring, new THREE.MeshBasicMaterial({ color: '#888888', transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.006;
    this.selectRing = new THREE.Mesh(geo.select, new THREE.MeshBasicMaterial({ color: '#1d2433', transparent: true, opacity: 0.75, depthWrite: false }));
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.position.y = 0.007;
    this.selectRing.visible = false;
    this.group.add(shadow, this.ring, this.selectRing, this.body);
    this.group.userData.actorKey = key;

    const trousers = mat(TROUSERS);
    const legs: Array<[THREE.Group, THREE.Group, number]> = [
      [this.thighL, this.shinL, -0.085],
      [this.thighR, this.shinR, 0.085],
    ];
    for (const [thigh, shin, x] of legs) {
      thigh.position.set(x, 0.52, 0);
      const t = new THREE.Mesh(geo.leg, trousers);
      t.position.y = -0.13;
      t.castShadow = true;
      thigh.add(t);
      shin.position.y = -0.26;
      const s = new THREE.Mesh(geo.leg, trousers);
      s.position.y = -0.13;
      s.castShadow = true;
      shin.add(s);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.18), mat('#1f232b'));
      shoe.position.set(0, -0.27, 0.04);
      shin.add(shoe);
      thigh.add(shin);
      this.body.add(thigh);
    }

    this.torso = new THREE.Mesh(geo.torso, mat('#888888'));
    this.torso.position.y = 0.82;
    this.torso.castShadow = true;
    this.body.add(this.torso);

    for (const [arm, x] of [
      [this.armL, -0.225],
      [this.armR, 0.225],
    ] as const) {
      arm.position.set(x, 1.0, 0);
      const m = new THREE.Mesh(geo.limb, mat('#666666'));
      m.position.y = -0.17;
      m.castShadow = true;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat(skin));
      hand.position.y = -0.34;
      arm.add(m, hand);
      this.body.add(arm);
    }

    this.head.position.y = 1.23;
    const headMesh = new THREE.Mesh(geo.head, mat(skin));
    headMesh.castShadow = true;
    const hairMesh = new THREE.Mesh(geo.hair, mat(hair));
    hairMesh.rotation.x = -0.35; // sits back on the head: front view shows a face, back view all hair
    hairMesh.position.set(0, 0.02, -0.012);
    const eyeMat = mat('#1d2433');
    for (const ex of [-0.05, 0.05]) {
      const eye = new THREE.Mesh(geo.eye, eyeMat);
      eye.position.set(ex, 0.0, 0.142);
      this.head.add(eye);
    }
    this.head.add(headMesh, hairMesh);
    this.body.add(this.head);

    this.mug = new THREE.Mesh(geo.mug, mat('#ffffff'));
    this.mug.position.set(0, -0.36, 0.05);
    this.armR.add(this.mug);
    this.papers = new THREE.Mesh(geo.paper, mat('#f7f3e8'));
    this.papers.position.set(0, -0.36, 0.08);
    this.papers.rotation.x = Math.PI / 2;
    this.armL.add(this.papers);
    // Ping pong paddle: red face on a wooden handle.
    this.paddle = new THREE.Group();
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.015, 20), mat('#c8392e', { roughness: 0.7 }));
    face.rotation.x = Math.PI / 2;
    face.position.set(0, -0.12, 0);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.02), mat('#b08a5e'));
    this.paddle.add(face, handle);
    this.paddle.position.set(0, -0.36, 0.02);
    this.armR.add(this.paddle);
  }

  setColor(shirt: string) {
    if (shirt === this.color) return;
    this.color = shirt;
    this.torso.material = mat(shirt);
    (this.ring.material as THREE.MeshBasicMaterial).color.set(shirt);
    const sleeve = mat(shade(shirt, 0.72));
    for (const arm of [this.armL, this.armR]) (arm.children[0] as THREE.Mesh).material = sleeve;
  }

  /**
   * Position and pose for this frame, from the choreographer. While walking they stand and face
   * their direction of travel; once arrived they take the spot's pose, prop and facing.
   */
  apply(f: Frame, scale: number) {
    this.scale = scale;
    this.group.scale.setScalar(scale);
    this.group.position.set(f.pos.x, 0, f.pos.y);
    this.walking = f.walking;
    if (f.placement) this.target = f.placement;
    this.wantAngle = f.walking ? f.heading : this.target ? FACE_ANGLE[this.target.face] : f.heading;
    if (!this.placed || this.reducedMotion()) this.group.rotation.y = this.wantAngle;
    this.placed = true;
  }

  /** World position of the top of the head, for DOM overlays. */
  headTop(out: THREE.Vector3): THREE.Vector3 {
    return this.head.getWorldPosition(out).add(new THREE.Vector3(0, 0.2 * this.group.scale.y, 0));
  }

  update(t: number, dt: number) {
    if (!this.placed) return;
    const calm = this.reducedMotion();
    // Turn smoothly toward where they're heading.
    let da = this.wantAngle - this.group.rotation.y;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.group.rotation.y += calm ? da : da * Math.min(1, dt * 10);

    if (this.walking) {
      // Walk cycle: legs and arms swing in opposition, a light bob (spec §7).
      this.stride += dt * 9;
      const s = Math.sin(this.stride);
      this.body.position.set(0, calm ? 0 : Math.abs(Math.cos(this.stride)) * 0.035, 0);
      this.thighL.rotation.x = s * 0.55;
      this.thighR.rotation.x = -s * 0.55;
      this.shinL.rotation.x = Math.max(0, -s) * 0.6;
      this.shinR.rotation.x = Math.max(0, s) * 0.6;
      this.armL.rotation.x = -s * 0.45;
      this.armR.rotation.x = s * 0.45;
      this.armR.rotation.z = 0;
      this.torso.scale.set(1, 1, 1);
      this.mug.visible = false;
      this.papers.visible = false;
      this.paddle.visible = false;
      return;
    }
    const p = this.target;
    if (!p) return;

    const sit = p.pose === 'sit';
    // Sitting: hips drop to the seat (≈0.42 in world units whatever the scale), thighs forward, shins down.
    this.body.position.y = sit ? 0.42 / this.scale - 0.52 : 0;
    this.body.position.z = sit ? -0.06 : 0;
    for (const thigh of [this.thighL, this.thighR]) thigh.rotation.x = sit ? -Math.PI / 2 : 0;
    for (const shin of [this.shinL, this.shinR]) shin.rotation.x = sit ? Math.PI / 2 : 0;

    const breath = calm ? 0 : Math.sin(t * 1.6 + this.phase) * 0.012;
    this.torso.scale.set(1, 1 + breath, 1);

    let l = 0;
    let r = 0;
    let rz = 0;
    switch (p.prop) {
      case 'typing': {
        const tap = calm ? 0 : Math.sin(t * 14 + this.phase) * 0.06;
        l = -1.15 + tap;
        r = -1.15 - tap;
        break;
      }
      case 'hand':
        r = -Math.PI * 0.95 + (calm ? 0 : Math.sin(t * 5 + this.phase) * 0.08);
        rz = 0.15;
        break;
      case 'mug':
        r = -1.25 + (calm ? 0 : Math.max(0, Math.sin(t * 0.7 + this.phase)) * -0.6);
        // Talking over coffee: the free hand gestures, a small nod.
        if (this.talking && !calm) {
          l = -0.75 + Math.sin(t * 4.2 + this.phase) * 0.28;
          this.head.rotation.x = Math.sin(t * 3.1) * 0.07;
        }
        break;
      case 'paddle': {
        // Ready stance; wind-up brings the paddle back and out, contact snaps it across.
        const pl = this.play;
        const wind = pl?.wind ?? 0;
        const swing = pl?.swing ?? 0;
        r = -0.9 - swing * 0.7 + wind * 0.35;
        rz = 0.2 + wind * 0.9 - swing * 0.5;
        l = -0.55;
        break;
      }
      case 'papers':
        l = -0.9;
        r = -0.6;
        break;
      default:
        l = calm ? 0 : Math.sin(t * 1.6 + this.phase) * 0.03;
        r = -l;
    }
    this.armL.rotation.x = l;
    this.armR.rotation.x = r;
    this.armR.rotation.z = -rz;
    this.mug.visible = p.prop === 'mug';
    this.papers.visible = p.prop === 'papers';
    this.paddle.visible = p.prop === 'paddle';
    if (!(p.prop === 'mug' && this.talking)) this.head.rotation.x = this.talking && p.prop === 'none' && !calm ? Math.sin(t * 2.4) * 0.09 : 0;
    this.head.rotation.y = 0;
    this.torso.rotation.y = 0;
    if (p.prop === 'paddle' && this.play && !calm) {
      const pl = this.play;
      // Shuffle sideways (body-local x), bend the knees, twist with the stroke, watch the ball.
      this.body.position.x = pl.lateral;
      this.body.position.y = -0.05 - pl.crouch * 0.12;
      for (const thigh of [this.thighL, this.thighR]) thigh.rotation.x = -pl.crouch * 0.9;
      for (const shin of [this.shinL, this.shinR]) shin.rotation.x = pl.crouch * 1.5;
      this.torso.rotation.y = -pl.wind * 0.45 + pl.swing * 0.35;
      const world = this.group.position;
      const dx = pl.look.x - (world.x + Math.cos(this.group.rotation.y) * pl.lateral);
      const dz = pl.look.y - (world.z - Math.sin(this.group.rotation.y) * pl.lateral);
      let yaw = Math.atan2(dx, dz) - this.group.rotation.y;
      yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      this.head.rotation.y = Math.max(-0.7, Math.min(0.7, yaw));
      this.head.rotation.x = -Math.max(-0.3, Math.min(0.3, (pl.look.z - 1.2) * 0.4));
    } else if (p.prop !== 'paddle') {
      this.body.position.x = 0;
    }
  }

  /** True while walking (shadows and full frame rate needed). */
  isMoving(): boolean {
    return this.walking;
  }

  /** Ping pong body language from the rally (null when not playing). */
  setPlay(p: PlayerPose | null) {
    this.play = p;
  }

  /** Café chit-chat: the current speaker gestures. */
  setTalking(on: boolean) {
    this.talking = on;
  }

  setSelected(on: boolean) {
    this.selectRing.visible = on;
  }

  dispose() {
    this.group.removeFromParent();
  }
}
