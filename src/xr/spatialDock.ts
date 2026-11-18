import * as THREE from 'three';

export type DockAction =
  | 'voice' | 'keyboard' | 'boards'
  | 'organize' | 'blindspot' | 'export'
  | 'preset' | 'recenter' | 'save';

const BUTTONS: { action: DockAction; icon: string; label: string }[] = [
  { action: 'voice', icon: 'VOX', label: 'Voice' },
  { action: 'keyboard', icon: 'ABC', label: 'Type' },
  { action: 'boards', icon: 'LIB', label: 'Boards' },
  { action: 'organize', icon: 'ORG', label: 'Organize' },
  { action: 'blindspot', icon: 'SCAN', label: 'Review' },
  { action: 'export', icon: 'MD', label: 'Export' },
  { action: 'preset', icon: 'FX', label: 'Preset' },
  { action: 'recenter', icon: 'CTR', label: 'Recenter' },
  { action: 'save', icon: 'SAVE', label: 'Save' },
];

function buttonTexture(icon: string, label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 320;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.strokeStyle = 'rgba(0,113,227,0.35)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(10, 10, 492, 300, 60);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0071e3';
  ctx.font = '700 92px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(icon, 256, 160);
  ctx.fillStyle = '#3a3a3c';
  ctx.font = '600 44px Inter, system-ui, sans-serif';
  ctx.fillText(label, 256, 248);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Ergonomic floating toolbar: 3 rows x 3 large poke targets, seated-reach sized. */
export class SpatialDock {
  group = new THREE.Group();
  buttons: THREE.Mesh[] = [];
  private flashT = new Map<DockAction, number>();

  constructor(scene: THREE.Scene) {
    const cols = 3;
    const dx = 0.24, dy = 0.15;
    BUTTONS.forEach((b, i) => {
      const mat = new THREE.MeshBasicMaterial({ map: buttonTexture(b.icon, b.label), transparent: true });
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.125, 0.03), mat);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = (col - (cols - 1) / 2) * dx;
      const y = (1 - row) * dy;
      m.position.set(x, y, Math.abs(x) * 0.14 + row * 0.015);
      m.rotation.y = -x * 0.8;
      m.userData.dockAction = b.action as DockAction;
      this.group.add(m);
      this.buttons.push(m);
      this.flashT.set(b.action, 0);
    });
    this.group.position.set(0, 0.9, -0.62);
    scene.add(this.group);
  }

  flash(action: DockAction): void { this.flashT.set(action, 1); }

  /** Gently yaw-follow the user; call per frame with camera yaw. */
  followUser(camera: THREE.Camera, dt: number): void {
    const camPos = camera.position;
    const dx = camPos.x - this.group.position.x;
    const dz = camPos.z - this.group.position.z;
    const want = Math.atan2(dx, dz);
    let cur = this.group.rotation.y;
    let d = want - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // only follow if user turned far (>35deg), else stay pinned
    if (Math.abs(d) > 0.6) this.group.rotation.y = cur + d * Math.min(dt * 1.5, 1);
  }

  tryHit(ray: THREE.Raycaster): DockAction | null {
    const hits = ray.intersectObjects(this.buttons, false);
    if (!hits.length) return null;
    return (hits[0].object.userData.dockAction as DockAction) ?? null;
  }

  /** Snap the whole dock in front of the camera (recenter companion). */
  placeInFront(camera: THREE.Camera, dist = 0.62, yOff = -0.55): void {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    this.group.rotation.y = yaw + Math.PI;
    const target = camera.position.clone().addScaledVector(dir, dist);
    target.y = Math.max(camera.position.y + yOff, 0.45);
    this.group.position.copy(target);
  }

  update(dt: number, _t: number): void {
    for (const b of this.buttons) {
      const a = b.userData.dockAction as DockAction;
      const f = this.flashT.get(a) || 0;
      if (f > 0) {
        this.flashT.set(a, Math.max(0, f - dt * 2));
        b.scale.setScalar(1 + f * 0.18);
      } else if (b.scale.x !== 1) {
        b.scale.setScalar(1);
      }
    }
  }
}
