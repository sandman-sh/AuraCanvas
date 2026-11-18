import * as THREE from 'three';
import type { SavedBoard } from '../utils/boardStore';

export type BoardPanelAction =
  | { kind: 'open'; id: string }
  | { kind: 'new' }
  | { kind: 'rename' }
  | { kind: 'delete'; id: string }
  | { kind: 'page'; dir: 1 | -1 }
  | { kind: 'present' }
  | { kind: 'undo' }
  | { kind: 'close' };

function textTexture(lines: string[], opts: { title?: boolean; danger?: boolean; dim?: boolean } = {}): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = opts.danger ? 'rgba(194,39,77,0.10)' : 'rgba(255,255,255,0.94)';
  ctx.strokeStyle = opts.danger ? '#c2274d' : 'rgba(0,113,227,0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(8, 8, 1008, 112, 28);
  ctx.fill(); ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.danger ? '#c2274d' : '#1d1d1f';
  ctx.font = opts.title ? '700 52px Inter, system-ui, sans-serif' : '500 44px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(lines[0] || '', 36, lines[1] ? 44 : 66, 640);
  if (lines[1]) {
    ctx.fillStyle = '#6e6e73';
    ctx.font = '400 34px Inter, system-ui, sans-serif';
    ctx.fillText(lines[1], 36, 88, 640);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * In-headset board manager: open / new / rename / delete saved boards with
 * hand pokes only. Delete requires a two-step poke confirm. The DOM
 * <select> picker would be invisible inside an immersive session, so this
 * 3D panel is the hands-only path; desktop keeps both.
 */
export class BoardPanel {
  group = new THREE.Group();
  visible = false;
  onAction: (a: BoardPanelAction) => void = () => undefined;

  private rows: THREE.Mesh[] = [];
  private rowActions: (BoardPanelAction | null)[] = [];
  private title!: THREE.Mesh;
  private titleCanvas!: HTMLCanvasElement;
  private titleTex!: THREE.CanvasTexture;
  private armDeleteId: string | null = null;
  private armAt = 0;
  private currentOpenId: string | null = null;
  /** Paging through saved boards — 3 rows fit the panel per page. */
  private page = 0;
  private readonly pageSize = 3;

  constructor(private scene: THREE.Scene) {
    this.titleCanvas = document.createElement('canvas');
    this.titleCanvas.width = 1024; this.titleCanvas.height = 110;
    this.titleTex = new THREE.CanvasTexture(this.titleCanvas);
    this.titleTex.colorSpace = THREE.SRGBColorSpace;
    this.title = new THREE.Mesh(
      new THREE.PlaneGeometry(0.86, 0.092),
      new THREE.MeshBasicMaterial({ map: this.titleTex, transparent: true, depthWrite: false })
    );
    this.title.position.y = 0.33;
    this.group.add(this.title);
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.94, 1.14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false })
    );
    bg.position.z = -0.015;
    this.group.add(bg);
    this.group.visible = false;
    scene.add(this.group);
  }

  private redrawTitle(): void {
    const tc = this.titleCanvas.getContext('2d')!;
    tc.clearRect(0, 0, 1024, 110);
    tc.fillStyle = '#1d1d1f';
    tc.font = '700 50px Inter, system-ui, sans-serif';
    tc.textAlign = 'center'; tc.textBaseline = 'middle';
    tc.fillText('Saved boards — poke to open', 512, 56, 960);
    this.titleTex.needsUpdate = true;
  }

  refresh(boards: SavedBoard[], currentOpenId: string | null, extras?: { undoCount: number; presenting: boolean }): void {
    this.currentOpenId = currentOpenId;
    for (const r of this.rows) {
      this.group.remove(r);
      (r.material as THREE.MeshBasicMaterial).map?.dispose();
      r.geometry.dispose();
    }
    this.rows = [];
    this.rowActions = [];
    this.redrawTitle();
    const pages = Math.max(1, Math.ceil(boards.length / this.pageSize));
    if (this.page > pages - 1) this.page = pages - 1;
    if (this.page < 0) this.page = 0;
    const shown = boards.slice(this.page * this.pageSize, this.page * this.pageSize + this.pageSize);
    if (!boards.length) {
      this.addRow(['No saved boards yet', 'poke + New board below to start'], 0.17, null);
    }
    shown.forEach((b, i) => {
      const date = new Date(b.updatedAt).toLocaleDateString();
      const marker = b.id === currentOpenId ? '● ' : '';
      this.addRow([`${marker}${b.name.slice(0, 26)}`, `${b.nodes.length} ideas · ${date} — poke to open`], 0.17 - i * 0.1, { kind: 'open', id: b.id });
    });
    let y = 0.17 - shown.length * 0.1;
    if (pages > 1) {
      if (this.page > 0) {
        this.addRow([`‹ Newer boards (page ${this.page}/${pages - 1})`, 'poke to go back'], y, { kind: 'page', dir: -1 });
        y -= 0.1;
      }
      if (this.page < pages - 1) {
        this.addRow([`Older boards › (page ${this.page + 2} of ${pages})`, 'poke for the next three'], y, { kind: 'page', dir: 1 });
        y -= 0.1;
      }
    }
    this.addRow(['+ New board', 'start empty, then type a goal'], y, { kind: 'new' });
    y -= 0.1;
    if (currentOpenId) {
      const cur = boards.find((x) => x.id === currentOpenId);
      const label = cur ? cur.name.slice(0, 22) : 'this board';
      const armed = this.armDeleteId === currentOpenId && performance.now() - this.armAt < 6000;
      this.addRow(
        [`✎ Rename "${label}"`, 'poke to retype the board name'],
        y, { kind: 'rename' }, false
      );
      y -= 0.1;
      this.addRow(
        armed ? ['DELETE — poke again to confirm', `this erases "${label}"`] : [`🗑 Delete "${label}"`, 'poke once to arm, again to confirm'],
        y, armed ? { kind: 'delete', id: currentOpenId } : { kind: 'delete', id: currentOpenId }, armed
      );
      y -= 0.1;
    }
    const presenting = extras?.presenting ?? false;
    this.addRow(
      presenting ? ['⏹ Stop present', 'end the narrated walkthrough'] : ['▶ Present board', 'narrated walkthrough'],
      y, { kind: 'present' }
    );
    y -= 0.1;
    const undoN = extras?.undoCount ?? 0;
    this.addRow(
      undoN > 0 ? [`↩ Undo (${undoN})`, 'restore the previous step'] : ['↩ Undo', 'nothing to undo yet'],
      y, { kind: 'undo' }
    );
  }

  private addRow(lines: string[], y: number, action: BoardPanelAction | null, danger = false): void {
    const mat = new THREE.MeshBasicMaterial({ map: textTexture(lines, { danger }), transparent: true });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.092), mat);
    m.position.set(0, y, 0);
    m.userData.panelAction = action;
    this.group.add(m);
    this.rows.push(m);
    this.rowActions.push(action);
  }

  /** Arm (or refresh) the two-step delete confirm for the open board. */
  armDelete(id: string): void {
    this.armDeleteId = id;
    this.armAt = performance.now();
  }

  disarmDelete(): void {
    this.armDeleteId = null;
  }

  get deleteArmed(): boolean {
    return this.armDeleteId !== null && performance.now() - this.armAt < 6000;
  }

  /** Number of poke rows currently built (test/verification hook). */
  get rowCount(): number { return this.rows.length; }

  /** True when the two-step confirm is currently armed for this board id. */
  isArmedFor(id: string): boolean {
    return this.armDeleteId === id && performance.now() - this.armAt < 6000;
  }

  /** Jump back to the first page (open, new board, deletes reset it). */
  resetPage(): void {
    this.page = 0;
  }

  /** Step the board list pager and report the new page. */
  turnPage(dir: 1 | -1): number {
    this.page = Math.max(0, this.page + dir);
    return this.page;
  }

  open(): void {
    this.group.visible = true;
    this.visible = true;
  }

  close(): void {
    this.group.visible = false;
    this.visible = false;
    this.disarmDelete();
  }

  placeInFront(camera: THREE.Camera, dist = 0.68, yOff = -0.28): void {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    const target = camera.position.clone().addScaledVector(dir, dist);
    target.y = Math.max(camera.position.y + yOff, 0.6);
    this.group.position.copy(target);
    this.group.lookAt(camera.position.x, target.y, camera.position.z);
  }

  /** Fingertip poke test. Returns the row action or null. */
  tryPoke(p: THREE.Vector3, radius = 0.075): BoardPanelAction | null {
    if (!this.visible) return null;
    const tmp = new THREE.Vector3();
    for (const r of this.rows) {
      r.getWorldPosition(tmp);
      if (tmp.distanceTo(p) < radius) {
        const a = r.userData.panelAction as BoardPanelAction | undefined;
        if (a) return a;
      }
    }
    return null;
  }

  /** Head-ray hit test for the no-hands fallback. */
  rayHit(ray: THREE.Raycaster): BoardPanelAction | null {
    if (!this.visible) return null;
    const hits = ray.intersectObjects(this.rows, false);
    if (!hits.length || !hits[0]) return null;
    return (hits[0].object.userData.panelAction as BoardPanelAction | undefined) ?? null;
  }
}
