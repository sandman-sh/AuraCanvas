import * as THREE from 'three';

export type KeyboardMode = 'goal' | 'title' | 'summary' | 'rename' | 'bullet';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

function keyTexture(label: string, accent = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = accent ? '#0071e3' : 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = accent ? '#0071e3' : 'rgba(0,113,227,0.35)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(6, 6, 116, 116, 26);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = accent ? '#fff' : '#1d1d1f';
  ctx.font = '700 56px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
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
    const mat = new THREE.MeshBasicMaterial({ map: keyTexture(label, accent), transparent: true });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.062, 0.012), mat);
    m.position.set(x, y, 0);
    m.userData.keyAction = action;
    m.userData.keyLabel = label;
    this.group.add(m);
    this.keys.push(m);
    this.flash.set(action + '|' + label, 0);
  }

  private build(): void {
    // backdrop
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.62),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false })
    );
    bg.position.z = -0.012;
    this.group.add(bg);

    this.titleCanvas = document.createElement('canvas');
    this.titleCanvas.width = 1024; this.titleCanvas.height = 96;
    this.titleTex = new THREE.CanvasTexture(this.titleCanvas);
    this.titleTex.colorSpace = THREE.SRGBColorSpace;
    this.titleMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.068),
      new THREE.MeshBasicMaterial({ map: this.titleTex, transparent: true, depthWrite: false })
    );
    this.titleMesh.position.y = 0.27;
    this.group.add(this.titleMesh);

    this.displayCanvas = document.createElement('canvas');
    this.displayCanvas.width = 1024; this.displayCanvas.height = 128;
    this.displayTex = new THREE.CanvasTexture(this.displayCanvas);
    this.displayTex.colorSpace = THREE.SRGBColorSpace;
    this.display = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.09),
      new THREE.MeshBasicMaterial({ map: this.displayTex, transparent: true, depthWrite: false })
    );
    this.display.position.y = 0.185;
    this.group.add(this.display);

    const kw = 0.068, gap = 0.008;
    ROWS.forEach((row, r) => {
      const y = 0.08 - r * 0.075;
      const totalW = row.length * (kw + gap);
      [...row].forEach((ch, i) => {
        this.addKey(ch, -totalW / 2 + (kw + gap) / 2 + i * (kw + gap), y, kw, 'char');
      });
    });
    // bottom row: space + backspace
    this.addKey('SPACE', -0.1, -0.15, 0.34, 'space');
    this.addKey('<X', 0.19, -0.15, 0.16, 'back');
    this.addKey('CLR', 0.325, -0.15, 0.1, 'clear');
    // action row
    this.addKey('GO', -0.19, -0.23, 0.22, 'submit', true);
    this.addKey('PRESET', 0.03, -0.23, 0.2, 'preset');
    this.addKey('CLOSE', 0.26, -0.23, 0.2, 'close');
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
      if (kp.distanceTo(p) > 0.045) continue;
      const id = (key.userData.keyAction as string) + '|' + (key.userData.keyLabel as string);
      if (!press) {
        // hover highlight only
        key.scale.setScalar(1.12);
        continue;
      }
      if (now - (this.lastHit.get(id) || 0) < 450) return null;
      this.lastHit.set(id, now);
      key.scale.setScalar(1.25);
      window.setTimeout(() => key.scale.setScalar(1), 140);
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
