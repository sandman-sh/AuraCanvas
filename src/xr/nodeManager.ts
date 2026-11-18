import * as THREE from 'three';
import type { AgentActionResponse, IdeaNodeData } from '../types/graph';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../types/graph';

export interface OrbNode {
  data: IdeaNodeData;
  group: THREE.Group;
  sphere: THREE.Mesh;
  halo: THREE.Mesh;
  card: THREE.Sprite;
  cardCanvas: HTMLCanvasElement;
  cardTex: THREE.CanvasTexture;
  target: THREE.Vector3;
  /** Smoothed grab velocity (world units/sec) — drives release glide. */
  vel: THREE.Vector3;
  prev: THREE.Vector3;
  /** Seconds since spawn — drives the pop-in scale ease. */
  spawnT: number;
  grabbed: boolean;
  hoverT: number;
  detail: boolean;
}

/** Ease-out-back: orb pops past 1.0 then settles — juicy spawn with no cost. */
function backOut(t: number): number {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/** Write curve points into a line's existing buffer — zero allocation per frame. */
function writeCurve(line: THREE.Line, pts: THREE.Vector3[]): void {
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = Math.min(pts.length, attr.count);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    attr.setXYZ(i, p.x, p.y, p.z);
  }
  attr.needsUpdate = true;
}

function makeGlowSprite(colorHex: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const col = '#' + colorHex.toString(16).padStart(6, '0');
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, col);
  g.addColorStop(0.35, col + 'AA');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55
  }));
  sp.scale.setScalar(0.62);
  return sp;
}

const sphereGeo = new THREE.SphereGeometry(0.075, 28, 28);
const haloGeo = new THREE.TorusGeometry(0.115, 0.005, 8, 48);

function drawCard(node: OrbNode): void {
  const ctx = node.cardCanvas.getContext('2d')!;
  const W = 1024, H = 512;
  ctx.clearRect(0, 0, W, H);
  // glass body — light Apple card
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.strokeStyle = 'rgba(0,113,227,0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(14, 14, W - 28, H - 28, 56);
  ctx.fill();
  ctx.stroke();
  const label = CATEGORY_LABELS[node.data.category] || node.data.category.toUpperCase();
  const col = '#' + (CATEGORY_COLORS[node.data.category] ?? 0x0071e3).toString(16).padStart(6, '0');
  // pill
  ctx.font = '700 40px Inter, system-ui, sans-serif';
  const pillW = ctx.measureText(label).width + 72;
  ctx.fillStyle = col + '33';
  ctx.strokeStyle = col;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(56, 52, pillW, 68, 34);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 92, 88);
  // title
  ctx.fillStyle = '#1d1d1f';
  ctx.font = '700 62px Inter, system-ui, sans-serif';
  ctx.fillText(node.data.title.slice(0, 26), 56, 190, W - 112);
  // summary
  ctx.fillStyle = '#6e6e73';
  ctx.font = '400 42px Inter, system-ui, sans-serif';
  ctx.fillText(node.data.summary.slice(0, 48), 56, 262, W - 112);
  // bullets
  const show = node.detail || node.grabbed ? node.data.bullets.slice(0, 3) : node.data.bullets.slice(0, 2);
  ctx.font = '400 36px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#3a3a3c';
  show.forEach((b, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(72, 322 + i * 56, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a3a3c';
    ctx.fillText(b.slice(0, 44), 100, 322 + i * 56, W - 170);
  });
  node.cardTex.needsUpdate = true;
}

export interface Edge { a: string; b: string; line: THREE.Line; }

export class NodeManager {
  nodes = new Map<string, OrbNode>();
  edges: Edge[] = [];
  tether: THREE.Line;
  tutorialLine: THREE.Line | null = null;

  constructor(private scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(21 * 3), 3));
    this.tether = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x0071e3, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    this.tether.visible = false;
    this.tether.frustumCulled = false;
    scene.add(this.tether);
  }

  clear(): void {
    for (const n of this.nodes.values()) {
      this.scene.remove(n.group);
      n.cardTex.dispose();
    }
    this.nodes.clear();
    for (const e of this.edges) {
      this.scene.remove(e.line);
      e.line.geometry.dispose();
    }
    this.edges = [];
    this.clearTether();
    if (this.tutorialLine) {
      this.scene.remove(this.tutorialLine);
      this.tutorialLine = null;
    }
  }

  getNodeData(): IdeaNodeData[] {
    return [...this.nodes.values()].map((n) => n.data);
  }

  /** Copies of node data stamped with current spatial targets — what gets saved. */
  getPositionedData(): IdeaNodeData[] {
    return [...this.nodes.values()].map((n) => ({
      ...n.data,
      bullets: [...n.data.bullets],
      pos: [n.target.x, n.target.y, n.target.z] as [number, number, number]
    }));
  }

  getNode(id: string): OrbNode | undefined { return this.nodes.get(id); }

  createNode(data: IdeaNodeData, pos: THREE.Vector3, fromPos?: THREE.Vector3, detail = false): OrbNode {
    const color = CATEGORY_COLORS[data.category] ?? 0x0071e3;
    const group = new THREE.Group();
    group.position.copy(fromPos ?? pos);

    const sphere = new THREE.Mesh(
      sphereGeo,
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.55,
        roughness: 0.3, metalness: 0.08, transparent: true, opacity: 0.94,
        envMapIntensity: 1.1
      })
    );
    group.add(sphere);
    const halo = new THREE.Mesh(
      haloGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
    );
    halo.rotation.x = Math.PI / 2.5;
    group.add(halo);
    const glow = makeGlowSprite(color);
    glow.position.z = -0.03;
    group.add(glow);

    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const card = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    card.scale.set(0.56, 0.28, 1);
    card.position.y = 0.25;
    group.add(card);

    const node: OrbNode = {
      data, group, sphere, halo, card, cardCanvas: canvas, cardTex: tex,
      target: pos.clone(), vel: new THREE.Vector3(), prev: group.position.clone(),
      spawnT: 0, grabbed: false, hoverT: 0, detail
    };
    // Pop-in: grows with an overshoot ease instead of blinking into existence.
    group.scale.setScalar(0.25);
    drawCard(node);
    group.userData.nodeId = data.id;
    sphere.userData.nodeId = data.id;
    this.scene.add(group);
    this.nodes.set(data.id, node);
    return node;
  }

  connect(aId: string, bId: string): void {
    if (aId === bId) return;
    if (this.edges.some((e) => (e.a === aId && e.b === bId) || (e.a === bId && e.b === aId))) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(17 * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x0a84ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    line.frustumCulled = false;
    this.scene.add(line);
    this.edges.push({ a: aId, b: bId, line });
    // Seed the buffer immediately so no uninitialized verts flash at origin.
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (a && b) {
      const mid = a.group.position.clone().add(b.group.position).multiplyScalar(0.5);
      mid.y += 0.06;
      writeCurve(line, new THREE.QuadraticBezierCurve3(a.group.position.clone(), mid, b.group.position.clone()).getPoints(16));
    }
  }

  /** Goal + branches fanned in an arc at arm's reach. Home overrides the default center. */
  spawnConstellation(resp: AgentActionResponse, auraPos: THREE.Vector3, home?: THREE.Vector3): void {
    const nodes = resp.nodes;
    if (!nodes.length) return;
    const goal = nodes[0];
    const center = home ? home.clone() : new THREE.Vector3(0, 1.3, -0.85);
    this.createNode(goal, center, auraPos.clone());
    const branches = nodes.slice(1);
    branches.forEach((b, i) => {
      const ang = branches.length <= 1 ? 0 : (i / (branches.length - 1) - 0.5) * 1.9;
      const r = 0.55;
      const pos = new THREE.Vector3(
        center.x + Math.sin(ang) * r,
        center.y + 0.05 - Math.abs(ang) * 0.12 + (i % 2 === 0 ? 0.06 : -0.06),
        center.z + (Math.cos(ang) - 1) * r * 0.7 + 0.08
      );
      this.createNode(b, pos, auraPos.clone());
      this.connect(goal.id, b.id);
    });
    (resp.connectToIds || []).forEach((id) => {
      if (this.nodes.has(id)) this.connect(goal.id, id);
    });
  }

  mergeVisual(aId: string, bId: string, synth: IdeaNodeData): OrbNode | null {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b) return null;
    const mid = a.group.position.clone().add(b.group.position).multiplyScalar(0.5);
    // Synthesis rises above its parents instead of overlapping them exactly,
    // and the parents recoil slightly so all three stay distinct and readable.
    mid.y += 0.18;
    const axis = b.group.position.clone().sub(a.group.position);
    if (axis.lengthSq() > 1e-6) {
      axis.normalize().multiplyScalar(0.07);
      a.target.addScaledVector(axis, -1);
      b.target.addScaledVector(axis, 1);
    }
    const node = this.createNode(synth, mid, mid, true);
    this.connect(synth.id, aId);
    this.connect(synth.id, bId);
    node.hoverT = 1;
    return node;
  }

  expandVisual(parentId: string, kids: IdeaNodeData[]): void {
    const parent = this.nodes.get(parentId);
    if (!parent) return;
    kids.forEach((k, i) => {
      const ang = (i / Math.max(kids.length - 1, 1) - 0.5) * 1.4;
      const pos = parent.target.clone().add(new THREE.Vector3(Math.sin(ang) * 0.45, -0.18 - i * 0.02, 0.18 + Math.cos(ang) * 0.1));
      this.createNode(k, pos, parent.group.position.clone(), true);
      this.connect(parentId, k.id);
    });
    parent.detail = true;
    const pn = this.nodes.get(parentId);
    if (pn) drawCard(pn);
  }

  autoOrganize(home?: THREE.Vector3): void {
    const list = [...this.nodes.values()];
    if (!list.length) return;
    const cats = [...new Set(list.map((n) => n.data.category))];
    const center = home ? home.clone() : new THREE.Vector3(0, 1.28, -0.85);
    list.forEach((n) => {
      const ci = Math.max(cats.indexOf(n.data.category), 0);
      const inCat = list.filter((m) => m.data.category === n.data.category);
      const idx = inCat.indexOf(n);
      const ang = cats.length <= 1 ? (idx / Math.max(inCat.length, 1) - 0.5) * 2 : (ci / cats.length) * Math.PI * 2;
      const rad = cats.length <= 1 ? 0.35 + idx * 0.18 : 0.5;
      n.target.set(
        center.x + Math.cos(ang + idx * 0.5) * rad,
        center.y + (idx % 3) * 0.16 - 0.1,
        center.z + Math.sin(ang * 0.7) * 0.3
      );
    });
  }

  pick(ray: THREE.Raycaster): OrbNode | null {
    const meshes: THREE.Object3D[] = [];
    for (const n of this.nodes.values()) meshes.push(n.sphere, n.card);
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    let o: THREE.Object3D | null = hits[0].object;
    while (o) {
      const id = o.userData?.nodeId as string | undefined;
      if (id && this.nodes.has(id)) return this.nodes.get(id)!;
      // card sprite has no nodeId on itself? we set group + sphere; walk up
      o = o.parent;
    }
    return null;
  }

  closestTo(p: THREE.Vector3, radius: number, exclude?: OrbNode): OrbNode | null {
    let best: OrbNode | null = null;
    let bd = radius;
    for (const n of this.nodes.values()) {
      if (n === exclude) continue;
      const d = n.group.position.distanceTo(p);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  pairWithin(d: number): [OrbNode, OrbNode] | null {
    const list = [...this.nodes.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].group.position.distanceTo(list[j].group.position) < d) return [list[i], list[j]];
      }
    }
    return null;
  }

  setTether(a: THREE.Vector3, b: THREE.Vector3, strength: number): void {
    this.tether.visible = true;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 0.05 * strength;
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
    writeCurve(this.tether, curve.getPoints(20));
    (this.tether.material as THREE.LineBasicMaterial).opacity = 0.25 + strength * 0.65;
  }

  clearTether(): void {
    this.tether.visible = false;
    (this.tether.material as THREE.LineBasicMaterial).opacity = 0;
  }

  showTutorialLink(aId: string, bId: string): void {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b) return;
    if (this.tutorialLine) this.scene.remove(this.tutorialLine);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
    this.tutorialLine = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color: 0x0071e3, dashSize: 0.03, gapSize: 0.02, transparent: true, opacity: 0.9
    }));
    writeCurve(this.tutorialLine, [a.target.clone(), b.target.clone()]);
    this.tutorialLine.computeLineDistances();
    this.tutorialLine.frustumCulled = false;
    this.scene.add(this.tutorialLine);
  }

  hideTutorialLink(): void {
    if (this.tutorialLine) {
      this.scene.remove(this.tutorialLine);
      this.tutorialLine = null;
    }
  }

  refreshCard(id: string): void {
    const n = this.nodes.get(id);
    if (n) drawCard(n);
  }

  update(dt: number, camera: THREE.Camera, t: number): void {
    const k = 1 - Math.exp(-dt * 7);
    const safeDt = Math.max(dt, 1e-4);
    for (const n of this.nodes.values()) {
      if (!n.grabbed) {
        n.group.position.lerp(n.target, k);
      } else {
        // Smoothed grab velocity for the release glide; target follows the hand.
        n.vel.lerp(new THREE.Vector3().subVectors(n.group.position, n.prev).divideScalar(safeDt), Math.min(dt * 10, 1));
        n.target.copy(n.group.position);
      }
      n.prev.copy(n.group.position);
      // Spawn pop-in: overshoot ease over ~0.45s, then rest at 1.0.
      if (n.spawnT < 0.45) {
        n.spawnT += dt;
        n.group.scale.setScalar(Math.max(0.25, backOut(Math.min(n.spawnT / 0.45, 1))));
      } else if (n.group.scale.x !== 1) {
        n.group.scale.setScalar(1);
      }
      n.halo.rotation.z = t * (0.7 + n.hoverT * 2);
      const want = 1 + n.hoverT * 0.45 + (n.grabbed ? 0.25 : 0);
      n.halo.scale.setScalar(n.halo.scale.x + (want - n.halo.scale.x) * Math.min(dt * 10, 1));
      // Material life: hovered/grabbed orbs glow hotter; idle orbs settle.
      const mat = n.sphere.material as THREE.MeshStandardMaterial;
      const heat = 0.55 + n.hoverT * 0.85 + (n.grabbed ? 0.55 : 0);
      mat.emissiveIntensity += (heat - mat.emissiveIntensity) * Math.min(dt * 8, 1);
      const sScale = 1 + n.hoverT * 0.07 + (n.grabbed ? 0.06 : 0);
      n.sphere.scale.setScalar(n.sphere.scale.x + (sScale - n.sphere.scale.x) * Math.min(dt * 10, 1));
      n.hoverT = Math.max(0, n.hoverT - dt * 3);
      n.card.lookAt(camera.position);
    }
    // Gentle separation: unheld orbs that overlap push their targets apart so
    // fused constellations never collapse into an unreadable stack.
    const list = [...this.nodes.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.grabbed || b.grabbed) continue;
        const d = a.target.distanceTo(b.target);
        if (d < 0.16 && d > 1e-4) {
          const push = new THREE.Vector3().subVectors(b.target, a.target).normalize()
            .multiplyScalar((0.16 - d) * 0.5 * Math.min(dt * 6, 1));
          a.target.addScaledVector(push, -1);
          b.target.addScaledVector(push, 1);
        }
      }
    }
    // Keep targets inside a comfortable reachable volume.
    for (const n of list) {
      n.target.x = THREE.MathUtils.clamp(n.target.x, -1.6, 1.6);
      n.target.y = THREE.MathUtils.clamp(n.target.y, 0.5, 2.3);
      n.target.z = THREE.MathUtils.clamp(n.target.z, -2.0, 0.3);
    }
    // edges follow endpoints (in-place buffer writes, no per-frame allocs)
    for (const e of this.edges) {
      const a = this.nodes.get(e.a);
      const b = this.nodes.get(e.b);
      if (!a || !b) continue;
      const pa = a.group.position;
      const pb = b.group.position;
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      mid.y += 0.06;
      const curve = new THREE.QuadraticBezierCurve3(pa, mid, pb);
      writeCurve(e.line, curve.getPoints(16));
    }
    if (this.tutorialLine && this.nodes.size >= 2) {
      const [x, y] = [...this.nodes.values()].slice(0, 2);
      if (x && y) {
        writeCurve(this.tutorialLine, [x.group.position, y.group.position]);
        this.tutorialLine.computeLineDistances();
      }
    }
  }
}
