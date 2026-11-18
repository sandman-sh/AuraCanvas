import * as THREE from 'three';

/** Single-draw-call pooled particle system for spawn + fusion bursts. */
export class ParticleSystem {
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private col: Float32Array;
  private cursor = 0;
  private count: number;

  constructor(scene: THREE.Scene, count = 1400) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.pos[i * 3 + 1] = -10;
      this.life[i] = 0;
      this.maxLife[i] = 1;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.02, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  burst(p: THREE.Vector3, colorHex: number, n = 90, speed = 0.9, up = 0.35): void {
    const c = new THREE.Color(colorHex);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.35 + Math.random() * 0.85);
      this.vel[i * 3] = Math.sin(ph) * Math.cos(th) * s;
      this.vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * s * 0.8 + up * Math.random();
      this.vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * s;
      this.life[i] = this.maxLife[i] = 0.7 + Math.random() * 0.8;
      const vary = 0.75 + Math.random() * 0.35;
      this.col[i * 3] = Math.min(c.r * vary, 1);
      this.col[i * 3 + 1] = Math.min(c.g * vary, 1);
      this.col[i * 3 + 2] = Math.min(c.b * vary, 1);
    }
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -10;
        continue;
      }
      this.vel[i * 3] *= 1 - 1.6 * dt;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * (1 - 1.2 * dt) - 0.25 * dt;
      this.vel[i * 3 + 2] *= 1 - 1.6 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    if (any) (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
