import * as THREE from 'three';
import type { AuraState } from '../types/graph';

function glowTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

/** Expressive levitating Crystalline AI Core with beams + caption billboard. */
export class AuraCore {
  group = new THREE.Group();
  private core!: THREE.Mesh;
  private wire!: THREE.Mesh;
  private ring1!: THREE.Mesh;
  private ring2!: THREE.Mesh;
  private glow!: THREE.Sprite;
  private auraLight!: THREE.PointLight;
  private caption!: THREE.Sprite;
  private captionCanvas: HTMLCanvasElement;
  private captionTex: THREE.CanvasTexture;
  private state: AuraState = 'idle';
  private beams: THREE.Line[] = [];
  private beamLife = 0;
  private coreMat!: THREE.MeshStandardMaterial;
  private baseY = 1.25;

  constructor(private scene: THREE.Scene) {
    this.captionCanvas = document.createElement('canvas');
    this.captionCanvas.width = 1024;
    this.captionCanvas.height = 256;
    this.captionTex = new THREE.CanvasTexture(this.captionCanvas);
    this.captionTex.colorSpace = THREE.SRGBColorSpace;
    this.build();
    this.group.position.set(0, this.baseY, -1.25);
    scene.add(this.group);
  }

  private build(): void {
    this.coreMat = new THREE.MeshStandardMaterial({
      color: 0x0a84ff, emissive: 0x0071e3, emissiveIntensity: 1.6,
      roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.95
    });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.11, 32, 32), this.coreMat);
    this.group.add(this.core);

    this.wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.19, 1),
      new THREE.MeshBasicMaterial({ color: 0x5e5ce6, wireframe: true, transparent: true, opacity: 0.85 })
    );
    this.group.add(this.wire);

    const ringGeo = new THREE.TorusGeometry(0.27, 0.006, 8, 64);
    this.ring1 = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.9 }));
    this.ring1.rotation.x = Math.PI / 2.4;
    this.group.add(this.ring1);
    this.ring2 = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x5e5ce6, transparent: true, opacity: 0.7 }));
    this.ring2.rotation.x = -Math.PI / 3;
    this.ring2.scale.setScalar(1.25);
    this.group.add(this.ring2);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture('rgba(10,132,255,0.55)', 'rgba(94,92,230,0.30)'),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
    }));
    this.glow.scale.setScalar(0.85);
    this.group.add(this.glow);

    // Local light: the core visibly warms nearby orbs as it moves states.
    const auraLight = new THREE.PointLight(0x0a84ff, 2.2, 3.2, 1.6);
    auraLight.position.set(0, 0.1, 0);
    this.group.add(auraLight);
    this.auraLight = auraLight;

    this.caption = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.captionTex, transparent: true, depthWrite: false, opacity: 0.96
    }));
    this.caption.scale.set(0.62, 0.155, 1);
    this.caption.position.y = 0.42;
    this.group.add(this.caption);
    this.setCaption('I am Aura — smash two orbs to begin');

    for (let i = 0; i < 6; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x0071e3, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
      }));
      line.visible = false;
      this.scene.add(line);
      this.beams.push(line);
    }
  }

  get position(): THREE.Vector3 { return this.group.position; }

  setState(s: AuraState): void { this.state = s; }

  setCaption(text: string): void {
    const ctx = this.captionCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 1024, 256);
    // glass pill
    const r = 48;
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = 'rgba(0,113,227,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(12, 44, 1000, 168, r);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1d1d1f';
    ctx.font = '600 52px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 34) { lines.push(cur.trim()); cur = w; }
      else cur += ' ' + w;
    }
    if (cur.trim()) lines.push(cur.trim());
    const shown = lines.slice(0, 2);
    shown.forEach((ln, i) => ctx.fillText(ln, 512, 108 + i * 60));
    this.captionTex.needsUpdate = true;
  }

  castBeams(targets: THREE.Vector3[]): void {
    const origin = this.group.position.clone();
    this.beams.forEach((b, i) => {
      const tgt = targets[i % Math.max(targets.length, 1)];
      if (!tgt) { b.visible = false; return; }
      const pts = [origin.clone(), tgt.clone()];
      b.geometry.setFromPoints(pts);
      b.visible = true;
      (b.material as THREE.LineBasicMaterial).opacity = 0.9;
    });
    this.beamLife = 1.6;
  }

  update(dt: number, t: number, audioLevel = 0): void {
    const breathe = Math.sin(t * 1.6) * 0.035;
    let scale = 1 + breathe;
    let spinBoost = 1;
    if (this.state === 'listening') { scale += 0.12 + audioLevel * 0.25; spinBoost = 3; }
    if (this.state === 'thinking') { scale += 0.07; spinBoost = 5; }
    if (this.state === 'speaking') { scale += Math.sin(t * 9) * 0.03 + 0.05; spinBoost = 1.6; }
    this.group.position.y = this.baseY + Math.sin(t * 1.1) * 0.03;
    this.group.scale.setScalar(scale);
    this.wire.rotation.y = t * (0.4 * spinBoost);
    this.wire.rotation.x = t * 0.23 * spinBoost;
    this.ring1.rotation.z = t * (0.8 * spinBoost);
    this.ring2.rotation.z = -t * (0.6 * spinBoost);
    const heat = this.state === 'thinking' ? new THREE.Color(0x5e5ce6) : new THREE.Color(0x0071e3);
    this.coreMat.emissive.lerp(heat, dt * 3);
    this.auraLight.color.lerp(heat, dt * 3);
    this.auraLight.intensity += (((this.state === 'thinking' || this.state === 'speaking') ? 3.4 : 2.2) - this.auraLight.intensity) * Math.min(dt * 4, 1);
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.7 + Math.sin(t * 2.2) * 0.12 + audioLevel * 0.3;

    if (this.beamLife > 0) {
      this.beamLife -= dt;
      const k = Math.max(this.beamLife / 1.6, 0);
      // refresh origins so beams track the core
      for (const b of this.beams) {
        if (!b.visible) continue;
        const pos = b.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(0, this.group.position.x, this.group.position.y, this.group.position.z);
        pos.needsUpdate = true;
        (b.material as THREE.LineBasicMaterial).opacity = 0.9 * k;
        if (this.beamLife <= 0) b.visible = false;
      }
    }
  }
}
