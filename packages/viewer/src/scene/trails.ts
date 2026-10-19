// Footprint trails for replay (spec §10.4): small dots on the floor in each person's color along
// the way they walked, plus a larger dot where they stopped. One instanced mesh, so thousands of
// dots cost a single draw call.

import * as THREE from 'three/webgpu';

const MAX = 6000;
const STEP = 0.35;

export class Trails {
  readonly mesh: THREE.InstancedMesh;
  private count = 0;
  private last = new Map<string, { x: number; y: number; walking: boolean }>();
  private m = new THREE.Matrix4();
  private c = new THREE.Color();

  constructor() {
    const geo = new THREE.CircleGeometry(0.06, 10);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
    this.last.clear();
  }

  /** Record where someone is; drops a dot every STEP units walked and a bigger one at each stop. */
  record(key: string, x: number, y: number, walking: boolean, color: string) {
    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, { x, y, walking });
      return;
    }
    if (walking && Math.hypot(x - prev.x, y - prev.y) >= STEP) {
      this.add(x, y, color, 1);
      this.last.set(key, { x, y, walking });
    } else if (!walking && prev.walking) {
      this.add(x, y, color, 2.2);
      this.last.set(key, { x, y, walking });
    }
  }

  private add(x: number, y: number, color: string, size: number) {
    const i = this.count % MAX;
    this.m.makeScale(size, 1, size).setPosition(x, 0.012, y);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, this.c.set(color));
    this.count++;
    this.mesh.count = Math.min(this.count, MAX);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
