import * as THREE from 'three';

export type KeyboardMode = 'goal' | 'title' | 'summary' | 'rename' | 'bullet';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

/** Key cap dimensions (world units): larger caps, real gaps, visible depth. */
const KEY_W = 0.072;
const KEY_H = 0.068;
const KEY_GAP = 0.012;
const KEY_PITCH = KEY_W + KEY_GAP;
const KEY_D = 0.02;

/** Key side/backing color: dark slate edges give every key real 3D thickness. */
const KEY_EDGE = 0x2a3a5f;

function keyFaceTexture(label: string, aspect: number, accent = false): { tex: THREE.CanvasTexture; flash: THREE.CanvasTexture } {
  const W = Math.max(160, Math.round(160 * aspect));
  const H = 160;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  // Subtle vertical gradient so the face reads as a formed cap, not a sticker.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  if (accent) { g.addColorStop(0, '#2f8fff'); g.addColorStop(1, '#0063d1'); }
  else { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e6ebf4'); }
  ctx.fillStyle = g;
  ctx.strokeStyle = accent ? 'rgba(0,80,180,0.9)' : 'rgba(0,113,227,0.55)';
  ctx.lineWidth = Math.max(6, W * 0.012);
  ctx.beginPath();
  ctx.roundRect(8, 8, W - 16, H - 16, 30);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = accent ? '#fff' : '#1d1d1f';
  ctx.font = `700 ${label.length > 3 ? 58 : 72}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, W / 2, H / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // Pressed/flash variant: same layout, tinted blue — swapped in on dwell fire.
  const fc = document.createElement('canvas');
  fc.width = W; fc.height = H;
  const fx = fc.getContext('2d')!;
  const fg = fx.createLinearGradient(0, 0, 0, H);
  fg.addColorStop(0, '#4da3ff'); fg.addColorStop(1, '#0a68d1');
  fx.fillStyle = fg;
  fx.beginPath();
  fx.roundRect(8, 8, W - 16, H - 16, 30);
  fx.fill();
  fx.fillStyle = '#fff';
  fx.font = `700 ${label.length > 3 ? 58 : 72}px Inter, system-ui, sans-serif`;
  fx.textAlign = 'center'; fx.textBaseline = 'middle';
  fx.fillText(label, W / 2, H / 2 + 4);
  const flash = new THREE.CanvasTexture(fc);
  flash.colorSpace = THREE.SRGBColorSpace;
  flash.anisotropy = 4;
  return { tex, flash };
}

/** Frosted container so the panel reads as one floating instrument. */
function panelTexture(): THREE.CanvasTexture {
  const W = 1024, H = 832;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0.34)');
  g.addColorStop(1, 'rgba(226,232,244,0.26)');
  ctx.fillStyle = g;
  ctx.strokeStyle = 'rgba(0,113,227,0.5)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, H - 20, 64);
  ctx.fill();
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Hands-only text entry: a floating QWERTY panel poked with the index fingertip.
 * Fallback whenever speech recognition is unavailable. Also used for node
 * editing and board rename. Desktop keeps the DOM input as its path.
 */
export class XRKeyboard {
  group = new THREE.Group();
  visible = false;
  mode: KeyboardMode = 'goal';
  targetNodeId: string | null = null;
  bulletIdx = 0;
  onSubmit: (text: string) => void = () => undefined;
  onClose: () => void = () => undefined;

  private buffer = '';
  /** Key meshes, public for the dwell hit-test in main.ts. */
  keys: THREE.Mesh[] = [];
  private display!: THREE.Mesh;
  private displayCanvas!: HTMLCanvasElement;
  private displayTex!: THREE.CanvasTexture;
  private titleMesh!: THREE.Mesh;
  private titleCanvas!: HTMLCanvasElement;
  private titleTex!: THREE.CanvasTexture;
  private lastHit = new Map<string, number>();
  private flash = new Map<string, number>();

  constructor(private scene: THREE.Scene) {
    this.build();
    this.group.visible = false;
    scene.add(this.group);
  }

  private addKey(label: string, x: number, y: number, w: number, action: string, accent = false): void {
    const h = KEY_H;
    const { tex, flash } = keyFaceTexture(label, w / h, accent);
    const face = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const edge = new THREE.MeshBasicMaterial({ color: KEY_EDGE });
    // Thick capped key: textured face, dark slate sides — reads as a real
    // button at grazing angles instead of a smeared sticker.
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, KEY_D),
      [edge, edge, edge, edge, face, edge]
    );
    m.position.set(x, y, 0);
    m.userData.keyAction = action;
    m.userData.keyLabel = label;
    m.userData.faceTex = tex;
    m.userData.flashTex = flash;
    this.group.add(m);
    this.keys.push(m);
    this.flash.set(action + '|' + label, 0);
  }

  /** Swap a key's face to its pressed variant (or back). */
  private setKeyFace(key: THREE.Mesh, pressed: boolean): void {
    const mats = key.material as THREE.MeshBasicMaterial[];
    const face = mats[4];
    if (!face) return;
    const next = (pressed ? key.userData.flashTex : key.userData.faceTex) as THREE.Texture | undefined;
    if (next && face.map !== next) { face.map = next; face.needsUpdate = true; }
  }

  private build(): void {
    // Frosted container backing — the panel reads as one floating instrument.
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.86, 0.70),
      new THREE.MeshBasicMaterial({ map: panelTexture(), transparent: true, depthWrite: false })
    );
    bg.position.z = -0.016;
    this.group.add(bg);

    this.titleCanvas = document.createElement('canvas');
    this.titleCanvas.width = 1024; this.titleCanvas.height = 96;
    this.titleTex = new THREE.CanvasTexture(this.titleCanvas);
    this.titleTex.colorSpace = THREE.SRGBColorSpace;
    this.titleMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.072),
      new THREE.MeshBasicMaterial({ map: this.titleTex, transparent: true, depthWrite: false })
    );
    this.titleMesh.position.y = 0.272;
    this.group.add(this.titleMesh);

    this.displayCanvas = document.createElement('canvas');
    this.displayCanvas.width = 1024; this.displayCanvas.height = 128;
    this.displayTex = new THREE.CanvasTexture(this.displayCanvas);
    this.displayTex.colorSpace = THREE.SRGBColorSpace;
    this.display = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.095),
      new THREE.MeshBasicMaterial({ map: this.displayTex, transparent: true, depthWrite: false })
    );
    this.display.position.y = 0.177;
    this.group.add(this.display);

    ROWS.forEach((row, r) => {
      const y = 0.081 - r * 0.084;
      const totalW = row.length * KEY_PITCH - KEY_GAP;
      [...row].forEach((ch, i) => {
        this.addKey(ch, -totalW / 2 + KEY_PITCH / 2 + i * KEY_PITCH, y, KEY_W, 'char');
      });
    });
    // bottom row: space + backspace
    this.addKey('SPACE', -0.14, -0.171, 0.36, 'space');
    this.addKey('<X', 0.155, -0.171, 0.16, 'back');
    this.addKey('CLR', 0.30, -0.171, 0.11, 'clear');
    // action row
    this.addKey('GO', -0.23, -0.257, 0.24, 'submit', true);
    this.addKey('PRESET', 0.02, -0.257, 0.20, 'preset');
    this.addKey('CLOSE', 0.26, -0.257, 0.20, 'close');
    this.redraw();
  }

  private redraw(): void {
    const tc = this.titleCanvas.getContext('2d')!;
    tc.clearRect(0, 0, 1024, 96);
    tc.fillStyle = '#1d1d1f';
    tc.font = '600 46px Inter, system-ui, sans-serif';
    tc.textAlign = 'center'; tc.textBaseline = 'middle';
    const titles: Record<KeyboardMode, string> = {
      goal: 'Type your goal — poke GO to dream',
      title: 'Edit card title — GO to save',
      summary: 'Edit summary — GO to save',
      rename: 'Rename board — GO to save',
      bullet: 'Edit first action — GO to save'
    };
    tc.fillText(titles[this.mode], 512, 50, 980);
    this.titleTex.needsUpdate = true;

    const dc = this.displayCanvas.getContext('2d')!;
    dc.clearRect(0, 0, 1024, 128);
    dc.fillStyle = 'rgba(255,255,255,0.95)';
    dc.strokeStyle = 'rgba(0,113,227,0.4)';
    dc.lineWidth = 4;
    dc.beginPath();
    dc.roundRect(8, 8, 1008, 112, 28);
    dc.fill(); dc.stroke();
    dc.fillStyle = '#1d1d1f';
    dc.font = '500 52px Inter, system-ui, sans-serif';
    dc.textAlign = 'left'; dc.textBaseline = 'middle';
    const shown = this.buffer || (this.mode === 'goal' ? 'e.g. Launch an AI app' : '');
    dc.fillStyle = this.buffer ? '#1d1d1f' : '#aeaeb2';
    dc.fillText(shown.slice(-32), 40, 66, 944);
    this.displayTex.needsUpdate = true;
  }

  open(mode: KeyboardMode, initial = '', targetNodeId: string | null = null, bulletIdx = 0): void {
    this.mode = mode;
    this.buffer = initial.slice(0, 120);
    this.targetNodeId = targetNodeId;
    this.bulletIdx = bulletIdx;
    this.resetInteraction();
    this.group.visible = true;
    this.visible = true;
    this.redraw();
  }

  close(): void {
    this.group.visible = false;
    this.visible = false;
    this.resetInteraction();
    this.onClose();
  }

  get value(): string { return this.buffer; }

  placeInFront(camera: THREE.Camera, dist = 0.62, yOff = -0.32): void {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    const target = camera.position.clone().addScaledVector(dir, dist);
    target.y = Math.max(camera.position.y + yOff, 0.7);
    this.group.position.copy(target);
    this.group.lookAt(camera.position.x, target.y, camera.position.z);
  }

  /** Head-ray hit test for the no-hands fallback. Returns key id + hit point. */
  rayHit(ray: THREE.Raycaster): { id: string; point: THREE.Vector3 } | null {
    if (!this.visible) return null;
    const hits = ray.intersectObjects(this.keys, false);
    if (!hits.length || !hits[0]) return null;
    const o = hits[0].object;
    return {
      id: (o.userData.keyAction as string) + '|' + (o.userData.keyLabel as string),
      point: hits[0].point.clone()
    };
  }

  keyMesh(id: string): THREE.Mesh | null {
    for (const k of this.keys) {
      if ((k.userData.keyAction as string) + '|' + (k.userData.keyLabel as string) === id) return k;
    }
    return null;
  }

  /** Dwell progress ring: scales the key 1 → 1.28 as hold progresses 0 → 1. */
  setDwellProgress(id: string | null, progress: number): void {
    for (const k of this.keys) {
      const kid = (k.userData.keyAction as string) + '|' + (k.userData.keyLabel as string);
      if (id && kid === id) k.scale.setScalar(1 + Math.min(Math.max(progress, 0), 1) * 0.28);
      else if (k.scale.x !== 1 && k.scale.x !== 1.12 && k.scale.x !== 1.25) k.scale.setScalar(1);
    }
  }

  /** Clear debounce latches + key scales so reopen never inherits stale state. */
  resetInteraction(): void {
    this.lastHit.clear();
    for (const k of this.keys) k.scale.setScalar(1);
  }

  /** Poke test against fingertip. Returns 'submit'|'close'|'preset'|null. */
  tryPoke(p: THREE.Vector3, press: boolean, click: () => void): string | null {
    if (!this.visible) return null;
    const now = performance.now();
    for (const key of this.keys) {
      const kp = new THREE.Vector3();
      key.getWorldPosition(kp);
      if (kp.distanceTo(p) > 0.05) continue;
      const id = (key.userData.keyAction as string) + '|' + (key.userData.keyLabel as string);
      if (!press) {
        // hover highlight only
        key.scale.setScalar(1.12);
        continue;
      }
      if (now - (this.lastHit.get(id) || 0) < 450) return null;
      this.lastHit.set(id, now);
      key.scale.setScalar(1.25);
      this.setKeyFace(key, true);
      window.setTimeout(() => { key.scale.setScalar(1); this.setKeyFace(key, false); }, 140);
      click();
      const action = key.userData.keyAction as string;
      if (action === 'char') this.buffer = (this.buffer + (key.userData.keyLabel as string)).slice(0, 120);
      else if (action === 'space') this.buffer = (this.buffer + ' ').slice(0, 120);
      else if (action === 'back') this.buffer = this.buffer.slice(0, -1);
      else if (action === 'clear') this.buffer = '';
      else if (action === 'submit') { this.redraw(); return 'submit'; }
      else if (action === 'close') return 'close';
      else if (action === 'preset') return 'preset';
      this.redraw();
      return null;
    }
    return null;
  }

  resetKeyScales(): void {
    for (const k of this.keys) if (k.scale.x !== 1) k.scale.setScalar(1);
  }

  setFlashFor(_t: number): void { /* reserved for dwell progress ring */ }

  update(_dt: number): void { /* scales decay handled in tryPoke timeouts */ }
}
