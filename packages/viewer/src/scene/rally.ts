// Ping pong rally between the two idle players (D22). Made to read like real play, not a
// metronome: each shot has its own pace, angle and height; players shuffle sideways to meet
// the ball, crouch, wind up as it comes, snap through contact and follow through; heads track
// the ball; after a few shots there's a short pause and a fresh serve.

import * as THREE from 'three/webgpu';
import { mat, rng } from './kit.ts';

const TABLE_Z = 0.78;

export interface PlayerPose {
  /** Sideways shuffle along the player's own left/right, in grid units. */
  lateral: number;
  /** 0..1 backswing as the ball approaches. */
  wind: number;
  /** 0..1 forward swing just after contact. */
  swing: number;
  /** Where the ball is, for the head to follow (grid x, y and height). */
  look: { x: number; y: number; z: number };
  /** Bent knees: deeper while receiving. */
  crouch: number;
}

interface Shot {
  duration: number;
  /** Lateral offset (grid y) where the ball arrives. */
  toY: number;
  height: number;
  bounceAt: number;
}

export class Rally {
  readonly ball: THREE.Mesh;
  private r = rng(17);
  private shot: Shot;
  private fromY = 0;
  private k = 0;
  private dir = 1; // +1: player A → B
  private shots = 0;
  private pause = 0;
  private laterals: [number, number] = [0, 0];

  constructor() {
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), mat('#fbf7ee', { roughness: 0.4 }));
    this.ball.visible = false;
    this.ball.castShadow = true;
    this.shot = this.nextShot();
  }

  private nextShot(): Shot {
    // Mix of rallies: mostly steady drives, sometimes a slow lob or a quick flat hit.
    const roll = this.r();
    const duration = roll < 0.15 ? 1.15 + this.r() * 0.2 : roll > 0.85 ? 0.55 + this.r() * 0.1 : 0.7 + this.r() * 0.25;
    return { duration, toY: (this.r() - 0.5) * 0.7, height: roll < 0.15 ? 0.45 : 0.16 + this.r() * 0.12, bounceAt: 0.55 + this.r() * 0.15 };
  }

  update(dt: number, a: { x: number; y: number } | null, b: { x: number; y: number } | null, calm: boolean): [PlayerPose, PlayerPose] | null {
    if (!a || !b || calm) {
      this.ball.visible = false;
      return null;
    }
    const players: [{ x: number; y: number }, { x: number; y: number }] = [a, b];
    const midY = (a.y + b.y) / 2;
    const look = { x: this.ball.position.x, y: this.ball.position.z, z: this.ball.position.y };

    // Between points: the server bounces the ball once, the other waits.
    if (this.pause > 0) {
      this.pause -= dt;
      const server = this.dir > 0 ? a : b;
      const sx = server.x + (this.dir > 0 ? 0.35 : -0.35);
      this.ball.visible = true;
      this.ball.position.set(sx, TABLE_Z + 0.25 + Math.abs(Math.sin(this.pause * 6)) * 0.25, server.y + 0.15);
      const relax = (i: 0 | 1): PlayerPose => ({ lateral: (this.laterals[i] *= 0.9), wind: 0, swing: 0, look, crouch: 0.15 });
      return [relax(0), relax(1)];
    }

    this.ball.visible = true;
    this.k += dt / this.shot.duration;
    if (this.k >= 1) {
      this.k -= 1;
      this.fromY = this.shot.toY;
      this.dir = -this.dir;
      this.shots++;
      this.shot = this.nextShot();
      // Every so often the point ends: short pause, then a fresh serve.
      if (this.shots > 4 + Math.floor(this.r() * 6)) {
        this.shots = 0;
        this.pause = 1.1 + this.r() * 0.8;
        this.k = 0;
      }
    }
    const k = this.k;
    const from = this.dir > 0 ? a : b;
    const to = this.dir > 0 ? b : a;
    const sgn = Math.sign(to.x - from.x) || 1;
    const x0 = from.x + sgn * 0.35;
    const x1 = to.x - sgn * 0.35;
    const x = x0 + (x1 - x0) * k;
    const y = midY + this.fromY + (this.shot.toY - this.fromY) * k;
    const bA = this.shot.bounceAt;
    const z =
      k < bA
        ? 1.0 + (TABLE_Z - 1.0) * (k / bA) + Math.sin((k / bA) * Math.PI) * this.shot.height
        : TABLE_Z + (1.0 - TABLE_Z) * ((k - bA) / (1 - bA)) + Math.sin(((k - bA) / (1 - bA)) * Math.PI) * this.shot.height * 0.8;
    this.ball.position.set(x, z, y);

    // Receiver shuffles to where the ball will arrive; hitter drifts back to the middle.
    const recv: 0 | 1 = this.dir > 0 ? 1 : 0;
    const hit: 0 | 1 = recv === 1 ? 0 : 1;
    const want: [number, number] = [0, 0];
    // Body-local +x is grid −y for the player facing east (A) and +y for the one facing west (B).
    want[recv] = (midY + this.shot.toY - players[recv].y) * (recv === 0 ? -1 : 1);
    want[hit] = this.laterals[hit] * 0.5;
    for (const i of [0, 1] as const) this.laterals[i] += (want[i] - this.laterals[i]) * Math.min(1, dt * 5);

    const ease = (v: number) => v * v * (3 - 2 * v);
    const pose = (i: 0 | 1): PlayerPose => {
      const receiving = i === recv;
      const wind = receiving ? ease(Math.max(0, (k - 0.55) / 0.45)) : 0;
      const swing = receiving ? 0 : ease(Math.max(0, 1 - k / 0.3));
      return { lateral: this.laterals[i], wind, swing, look: { x, y, z }, crouch: receiving ? 0.25 + wind * 0.2 : 0.18 };
    };
    return [pose(0), pose(1)];
  }
}
