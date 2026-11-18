import * as THREE from 'three';
import { SceneManager } from './xr/sceneManager';
import { AuraCore } from './xr/auraCore';
import { NodeManager, type OrbNode } from './xr/nodeManager';
import { ParticleSystem } from './xr/particleSystem';
import { SpatialDock, type DockAction } from './xr/spatialDock';
import { HandInputManager } from './xr/handInputManager';
import { XRKeyboard, type KeyboardMode } from './xr/xrKeyboard';
import { BoardPanel, type BoardPanelAction } from './xr/boardPanel';
import { DesktopInput } from './xr/desktopInput';
import { VoiceController } from './speech/voiceController';
import { sound } from './audio/soundEngine';
import { runAgent, getServerAiStatus, friendlyAiName } from './ai/agentClient';
import { PRESETS } from './ai/localAgentEngine';
import { buildMarkdown, downloadMarkdown, copyMarkdown } from './utils/markdownExport';
import { saveBoard, listBoards, loadBoard, deleteBoard, lastBoardId, clearLastBoard, loadSeatedPref, saveSeatedPref, storageAvailable, type SavedBoard } from './utils/boardStore';
import { CATEGORY_COLORS } from './types/graph';
import type { CritiqueMode, IdeaNodeData } from './types/graph';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ---------- app state ----------
const sceneManager = new SceneManager();
let aura: AuraCore | null = null;
let nodes: NodeManager | null = null;
let particles: ParticleSystem | null = null;
let dock: SpatialDock | null = null;
let hands: HandInputManager | null = null;
let keyboard: XRKeyboard | null = null;
let boardPanel: BoardPanel | null = null;
let desktop: DesktopInput | null = null;
const voice = new VoiceController();
voice.setMetaKey(''); // no browser key: all AI goes through the server .env key

let worldReady = false;
let onboarded = false;
let busy = false;
let genCount = 0;
let presetIdx = 0;
let muted = false;
let captionsOn = true;
let lastHum = 0;
const merging = new Set<string>();
const pokeCooldown = new Map<string, number>();
const expandCooldown = new Map<string, number>();
const heldByHand = new Map<number, OrbNode>();
let wasPinching = [false, false];
// Head-direction dwell fallback (NOT eye tracking): used only when no hand is tracked.
const gaze = { target: '', time: 0 };
const GAZE_DWELL = 1.1;
const GAZE_KEY_DWELL = 0.8;
// Board persistence + selection
let currentBoardId: string | null = null;
let boardName = 'Untitled board';
let selectedId: string | null = null;
let seated = loadSeatedPref();
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Seated vs standing reach: distances the layout is built around. */
function reach(): { dist: number; boardY: number; dockY: number; kbY: number } {
  return seated
    ? { dist: 0.68, boardY: 1.15, dockY: -0.62, kbY: -0.30 }
    : { dist: 0.95, boardY: 1.35, dockY: -0.52, kbY: -0.30 };
}

/** Last recentered board anchor in XR. New content lands here, not at fixed coords. */
let boardHome: THREE.Vector3 | null = null;

/** Where new content should land: recentered home in XR, default on desktop. */
function xrHome(): THREE.Vector3 | undefined {
  if (!sceneManager.renderer.xr.isPresenting) return undefined;
  if (boardHome) return boardHome.clone();
  return new THREE.Vector3(0, reach().boardY, -0.85);
}

/** Review lenses cycled by each Review press. */
const CRIT_MODES: CritiqueMode[] = ['blindspot', 'premortem', 'fivewhys'];
const CRIT_LABELS: Record<CritiqueMode, string> = {
  blindspot: 'Blind-spot scan',
  premortem: 'Premortem',
  fivewhys: 'Five whys'
};
let critIdx = 0;

/** Undo history: board snapshots before each mutation (cap 25). */
interface BoardSnapshot {
  nodes: IdeaNodeData[];
  edges: { a: string; b: string }[];
  boardName: string;
  positions: Record<string, [number, number, number]>;
}
const undoStack: BoardSnapshot[] = [];

function snapshot(): void {
  if (!nodes) return;
  const positions: Record<string, [number, number, number]> = {};
  for (const n of nodes.nodes.values()) {
    positions[n.data.id] = [n.group.position.x, n.group.position.y, n.group.position.z];
  }
  undoStack.push({
    nodes: JSON.parse(JSON.stringify(nodes.getNodeData())) as IdeaNodeData[],
    edges: nodes.edges.map((e) => ({ a: e.a, b: e.b })),
    boardName,
    positions
  });
  if (undoStack.length > 25) undoStack.shift();
}

function clearUndo(): void { undoStack.length = 0; }

function undo(): void {
  if (busy || present.on) return;
  const s = undoStack.pop();
  if (!s || !nodes || !aura) { toast('Nothing to undo.'); return; }
  const nm = nodes;
  const ac = aura;
  nm.clear();
  heldByHand.clear();
  merging.clear();
  onboarded = true;
  boardName = s.boardName;
  s.nodes.forEach((d) => {
    const p = s.positions[d.id];
    const pos = p ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3(0, 1.3, -0.85);
    nm.createNode(d, pos, ac.position.clone(), true);
  });
  for (const e of s.edges) nm.connect(e.a, e.b);
  selectedId = null;
  setFocusMode(null);
  persistBoard();
  setCaption('Undone — board restored to the previous step.');
  toast('Undone.');
  sound.click();
  boardPanel?.refresh(listBoards(), currentBoardId, panelExtras());
}

/** Narrated walkthrough state. */
const present = { on: false, order: [] as string[], idx: 0, timer: 0 };
const PRESENT_STEP = 4.5;

function togglePresent(): void {
  if (present.on) { stopPresent('Present mode off.'); return; }
  if (!nodes || nodes.nodes.size === 0 || !onboarded) {
    toast('Generate a board first, then present it.');
    return;
  }
  const goal = [...nodes.nodes.values()].find((n) => n.data.category === 'goal');
  const rest = [...nodes.nodes.values()].filter((n) => n !== goal).map((n) => n.data.id);
  present.order = [...(goal ? [goal.data.id] : []), ...rest];
  present.idx = 0;
  present.timer = 0;
  present.on = true;
  boardPanel?.close();
  keyboard?.close();
  setFocusMode(null);
  setCaption(`Presenting 1 of ${present.order.length} — toggle Present to stop.`);
  toast('Present mode: narrated walkthrough. Toggle again to stop.');
  sound.click();
  boardPanel?.refresh(listBoards(), currentBoardId, panelExtras());
}

function stopPresent(msg?: string): void {
  if (!present.on) return;
  present.on = false;
  present.order = [];
  present.idx = 0;
  present.timer = 0;
  setFocusMode(null);
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  if (msg) setCaption(msg);
  boardPanel?.refresh(listBoards(), currentBoardId, panelExtras());
}

/** Focus mode: dim everything except one node. Null = off. */
let focusId: string | null = null;
const savedOpacity = new Map<THREE.Material, number>();

function setFocusMode(id: string | null): void {
  for (const [m, o] of savedOpacity) { m.opacity = o; }
  savedOpacity.clear();
  focusId = id;
  if (!id || !nodes) return;
  for (const n of nodes.nodes.values()) {
    if (n.data.id === id) { n.hoverT = 1; continue; }
    n.group.traverse((o) => {
      const mat = (o as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of mats) {
        const mm = m as THREE.Material & { opacity?: number };
        if (typeof mm.opacity === 'number') {
          if (!savedOpacity.has(mm)) savedOpacity.set(mm, mm.opacity);
          mm.opacity = Math.min(mm.opacity, 0.12);
        }
      }
    });
  }
  for (const e of nodes.edges) {
    if (e.a !== id && e.b !== id) {
      const m = e.line.material as THREE.LineBasicMaterial;
      if (!savedOpacity.has(m)) savedOpacity.set(m, m.opacity);
      m.opacity = 0.04;
    }
  }
}

function toggleFocus(): void {
  if (!nodes) return;
  if (focusId) { setFocusMode(null); toast('Focus off.'); setCaption('Focus off — full board visible.'); return; }
  const target = (selectedId && nodes.getNode(selectedId))
    || [...nodes.nodes.values()].find((n) => n.data.category === 'goal')
    || [...nodes.nodes.values()][0];
  if (!target) { toast('Nothing to focus on yet.'); return; }
  selectedId = target.data.id;
  setFocusMode(target.data.id);
  toast(`Focused on "${target.data.title}". Toggle again for full board.`);
  setCaption(`Focused on "${target.data.title}" — toggle Focus for the full board.`);
  sound.click();
}

function panelExtras(): { undoCount: number; presenting: boolean } {
  return { undoCount: undoStack.length, presenting: present.on };
}

// ---------- HUD helpers ----------
function toast(msg: string, ms = 2600): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  window.setTimeout(() => el.classList.add('hidden'), ms);
}

function setCaption(text: string): void {
  if (!captionsOn) return;
  $('caption').textContent = text;
  aura?.setCaption(text);
}

function setBusy(b: boolean): void {
  busy = b;
  $('promptInput').style.opacity = b ? '0.55' : '1';
}

/** Display name for the engine that actually answered. Never mislabels providers. */
export function providerLabel(p: string): string {
  if (p === 'meta-direct' || p === 'meta') return 'Meta Muse';
  if (p === 'gemini') return 'Google Gemini';
  if (p === 'openai') return 'OpenAI';
  if (p === 'server') return 'Server AI';
  if (p === 'local') return 'Offline engine';
  return p || 'Unknown engine';
}

function markAi(live: boolean, provider: string): void {
  $('aiBadge').textContent = live ? `AI · ${friendlyAiName(provider)}` : 'AI · Offline';
}

/** Ask the server which engine is configured and show it in plain language. */
function refreshAiBadge(): void {
  $('aiBadge').textContent = 'AI · Starting…';
  void getServerAiStatus().then((s) => {
    $('aiBadge').textContent = s.mode === 'local' ? 'AI · Offline' : `AI · ${friendlyAiName(s.mode, s.model)}`;
  });
}

function markSaved(when = Date.now()): void {
  const el = $('saveState');
  if (el) el.textContent = `Saved ${new Date(when).toLocaleTimeString()}`;
}

function markSaveFailed(): void {
  const el = $('saveState');
  if (el) el.textContent = 'Save failed — storage unavailable';
}

function markUnsaved(): void {
  const el = $('saveState');
  if (el) el.textContent = 'Not saved yet';
}

/**
 * Persist current board. Returns the board on success, null when empty or
 * when storage failed. A failed save is NEVER reported as successful.
 */
function persistBoard(silent = true): SavedBoard | null {
  if (!nodes || nodes.nodes.size === 0) return null;
  const { board, ok } = saveBoard(
    boardName, nodes.getPositionedData(),
    nodes.edges.map((e) => ({ a: e.a, b: e.b })), currentBoardId || undefined
  );
  if (!ok || !board) {
    markSaveFailed();
    if (!silent) toast('Save failed — browser storage is unavailable. Export still works.');
    return null;
  }
  currentBoardId = board.id;
  boardName = board.name;
  markSaved(board.updatedAt);
  refreshBoardPicker();
  if (!silent) toast(`Board "${board.name}" saved on this device.`);
  return board;
}

function refreshBoardPicker(): void {
  const sel = $('boardSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const boards = listBoards();
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = boards.length ? 'Open saved…' : 'No saved boards';
  sel.appendChild(opt0);
  for (const b of boards) {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = `${b.name} (${b.nodes.length})`;
    if (b.id === currentBoardId) o.selected = true;
    sel.appendChild(o);
  }
}

// ---------- world ----------
function ensureWorld(passthrough: boolean): void {
  if (worldReady) {
    sceneManager.setPassthrough(passthrough);
    return;
  }
  sceneManager.init($('app'), passthrough);
  const scene = sceneManager.scene;
  aura = new AuraCore(scene);
  nodes = new NodeManager(scene);
  particles = new ParticleSystem(scene);
  dock = new SpatialDock(scene);
  hands = new HandInputManager(scene, sceneManager.renderer);
  keyboard = new XRKeyboard(scene);
  keyboard.onSubmit = (text) => { void applyKeyboardSubmit(text); };
  keyboard.onClose = () => { setCaption('Keyboard closed.'); };
  sceneManager.onControllerSelect = (side, origin, dir) => controllerSelect(side, origin, dir);
  boardPanel = new BoardPanel(scene);
  desktop = new DesktopInput(sceneManager.camera, sceneManager.renderer.domElement, nodes, dock, {
    onExpand: (n) => void doExpand(n),
    onDock: (a) => void doDock(a),
    onMergeRequest: (a, b) => void doMerge(a, b),
    onDragEnd: () => { snapshot(); persistBoard(); }
  }, sound);

  voice.onResult = (text) => { if (text) void doGenerate(text); };
  voice.onCaption = (text) => setCaption(text);
  voice.onListenState = (listening) => {
    $('micBtn').classList.toggle('live', listening);
    aura?.setState(listening ? 'listening' : 'idle');
    if (listening) setCaption('Listening… speak your goal.');
  };

  sceneManager.startLoop((dt, t, frame) => tick(dt, t, frame));
  worldReady = true;
}

function removeOrb(id: string): void {
  if (!nodes) return;
  const n = nodes.getNode(id);
  if (!n) return;
  sceneManager.scene.remove(n.group);
  n.cardTex.dispose();
  nodes.nodes.delete(id);
  nodes.edges = nodes.edges.filter((e) => {
    if (e.a === id || e.b === id) {
      sceneManager.scene.remove(e.line);
      e.line.geometry.dispose();
      return false;
    }
    return true;
  });
}

function spawnOnboarding(): void {
  if (!nodes || !aura) return;
  nodes.clear();
  heldByHand.clear();
  merging.clear();
  clearUndo();
  stopPresent();
  onboarded = false;
  currentBoardId = null;
  boardName = 'Untitled board';
  selectedId = null;
  markUnsaved();
  refreshBoardPicker();
  const a: IdeaNodeData = {
    id: 'tut_a', title: 'Your Big Idea', summary: 'Pinch me — then smash us together',
    bullets: ['Grab with pinch or mouse', 'Drag into the other orb'], category: 'tutorial'
  };
  const b: IdeaNodeData = {
    id: 'tut_b', title: 'Aura AI Agent', summary: 'Fuse us to wake Aura up',
    bullets: ['One hand or two', 'Touch them together'], category: 'product'
  };
  const oy = sceneManager.renderer.xr.isPresenting ? reach().boardY : 1.3;
  nodes.createNode(a, new THREE.Vector3(-0.44, oy, -0.8), aura.position.clone());
  nodes.createNode(b, new THREE.Vector3(0.44, oy + 0.02, -0.8), aura.position.clone());
  nodes.showTutorialLink('tut_a', 'tut_b');
  sound.spawn();
  setCaption('Step 1 of 1: pinch one orb, drag it into the other — or press Skip Tutorial below.');
  toast('Tutorial: drag one orb into the other to begin (Skip available below).');
}

function skipTutorial(): void {
  if (!nodes || !aura) return;
  onboarded = true;
  nodes.clear();
  heldByHand.clear();
  merging.clear();
  setCaption('Tutorial skipped. Type a goal, tap Voice, or press Preset.');
  toast('Tutorial skipped — tap ABC to type, VOX to speak, or FX for a preset.');
  sound.click();
}

// ---------- agent flows ----------
async function doGenerate(prompt: string): Promise<void> {
  if (!nodes || !aura || !particles || busy) return;
  const clean = prompt.trim().slice(0, 200);
  if (!clean) return;
  if (!onboarded && (nodes.getNode('tut_a') || nodes.getNode('tut_b'))) {
    nodes.clear();
    onboarded = true;
  }
  snapshot();
  stopPresent();
  setBusy(true);
  aura.setState('thinking');
  setCaption(`Dreaming up "${clean.slice(0, 40)}"…`);
  aura.castBeams([...nodes.nodes.values()].slice(0, 6).map((n) => n.group.position));
  try {
    const { response, live, provider } = await runAgent('generate', clean, { existingNodes: nodes.getNodeData() });
    const before = new Set(nodes.nodes.keys());
    nodes.spawnConstellation(response, aura.position, xrHome());
    // offset repeat generations so constellations don't stack
    genCount++;
    const ox = ((genCount - 1) % 3 - 1) * 0.35;
    if (ox !== 0) {
      for (const n of nodes.nodes.values()) {
        if (!before.has(n.data.id)) {
          n.target.x += ox;
          n.group.position.x += ox;
        }
      }
    }
    for (const n of nodes.nodes.values()) {
      if (!before.has(n.data.id)) particles.burst(n.group.position, CATEGORY_COLORS[n.data.category] ?? 0x0071e3, 40, 0.5);
    }
    sound.spawn();
    aura.setState('speaking');
    voice.speak(response.spokenReply);
    markAi(live, provider);
    if (!live) setCaption(`Offline engine — no cloud used. ${clean.slice(0, 40)} mapped.`);
    persistBoard();
    window.setTimeout(() => aura?.setState('idle'), 3500);
  } finally {
    setBusy(false);
  }
}

async function doMerge(a: OrbNode, b: OrbNode): Promise<void> {
  if (!nodes || !aura || !particles || busy) return;
  const key = [a.data.id, b.data.id].sort().join('|');
  if (merging.has(key)) return;
  merging.add(key);
  try {
    // tutorial fusion → awakening
    const isTut =
      (a.data.id === 'tut_a' && b.data.id === 'tut_b') || (a.data.id === 'tut_b' && b.data.id === 'tut_a');
    const mid = a.group.position.clone().add(b.group.position).multiplyScalar(0.5);
    snapshot();
    stopPresent();
    if (isTut) {
      nodes.hideTutorialLink();
      particles.burst(mid, 0x0071e3, 220, 1.4, 0.5);
      sound.fusionChord();
      sound.auraWake();
      sceneManager.pulseHaptics(0.9, 45);
      removeOrb('tut_a');
      removeOrb('tut_b');
      onboarded = true;
      const wake: IdeaNodeData = {
        id: 'aura_online', title: 'Aura Online', summary: 'Your agent is awake — speak or tap a preset',
        bullets: ['Say a goal out loud', 'Or tap a preset pill', 'Smash any 2 orbs to fuse'], category: 'synthesis'
      };
      const orb = nodes.createNode(wake, mid, mid, true);
      void orb;
      aura.setState('speaking');
      voice.speak('Aura online. Tell me your goal, or pick an example to begin.');
      persistBoard();
      window.setTimeout(() => {
        aura?.setState('idle');
        if (sceneManager.renderer.xr.isPresenting) openKeyboardForGoal();
        else {
          setCaption('Aura is awake — type your goal below, or tap an example pill.');
          toast('Aura is awake — type your goal, or tap an example pill.');
          document.getElementById('promptInput')?.focus();
        }
      }, 1200);
      return;
    }
    setBusy(true);
    aura.setState('thinking');
    aura.castBeams([a.group.position, b.group.position]);
    nodes.clearTether();
    sound.fusionChord();
    sceneManager.pulseHaptics(0.9, 40);
    particles.burst(mid, 0x0071e3, 160, 1.1, 0.4);
    const { response, live, provider } = await runAgent('merge', `${a.data.title} + ${b.data.title}`, {
      existingNodes: nodes.getNodeData(), mergePair: [a.data, b.data]
    });
    const synth = response.nodes[0];
    if (synth) {
      nodes.mergeVisual(a.data.id, b.data.id, { ...synth, category: 'synthesis' });
      if (!reducedMotion) particles.burst(mid, 0x0071e3, 120, 0.8, 0.4);
      sound.spawn();
      selectedId = synth.id;
    }
    aura.setState('speaking');
    voice.speak(response.spokenReply);
    markAi(live, provider);
    persistBoard();
    window.setTimeout(() => aura?.setState('idle'), 3200);
  } finally {
    setBusy(false);
    window.setTimeout(() => merging.delete(key), 2000);
  }
}

async function doExpand(node: OrbNode): Promise<void> {
  if (!nodes || !aura || !particles || busy) return;
  if (node.data.id.startsWith('tut_')) {
    toast('Merge the two tutorial orbs together first.');
    return;
  }
  const now = performance.now();
  if (now - (expandCooldown.get(node.data.id) || 0) < 4000) {
    toast('Already expanded — wait a moment before expanding again.');
    return;
  }
  expandCooldown.set(node.data.id, now);
  snapshot();
  stopPresent();
  setBusy(true);
  aura.setState('thinking');
  aura.castBeams([node.group.position]);
  setCaption(`Breaking down "${node.data.title}"…`);
  try {
    const { response, live, provider } = await runAgent('expand', node.data.title, {
      existingNodes: nodes.getNodeData(), focusNode: node.data
    });
    nodes.expandVisual(node.data.id, response.nodes.slice(0, 3));
    sound.spawn();
    if (!reducedMotion) particles.burst(node.group.position, CATEGORY_COLORS[node.data.category] ?? 0x0071e3, 70, 0.7);
    aura.setState('speaking');
    voice.speak(response.spokenReply);
    markAi(live, provider);
    persistBoard();
    window.setTimeout(() => aura?.setState('idle'), 3000);
  } finally {
    setBusy(false);
  }
}

async function doCritique(): Promise<void> {
  if (!nodes || !aura || !particles || busy) return;
  if (!nodes.nodes.size || !onboarded) {
    toast('Generate a board first, then run a Review.');
    return;
  }
  const mode: CritiqueMode = CRIT_MODES[critIdx % CRIT_MODES.length];
  critIdx++;
  snapshot();
  setBusy(true);
  dock?.flash('blindspot');
  aura.setState('thinking');
  setCaption(mode === 'blindspot' ? 'Scanning for blind spots…' : mode === 'premortem' ? 'Premortem: assuming this failed…' : 'Five whys: drilling to the root cause…');
  try {
    const existing = nodes.getNodeData();
    aura.castBeams([...nodes.nodes.values()].slice(0, 6).map((n) => n.group.position));
    const { response, live, provider } = await runAgent('critique', `mode:${mode} — find the missing angle`, { existingNodes: existing, critiqueMode: mode });
    const insight = response.nodes[0];
    if (insight) {
      // attach near the weakest area (fewest links), default near goal
      const linkCount = new Map<string, number>();
      for (const e of nodes.edges) {
        linkCount.set(e.a, (linkCount.get(e.a) || 0) + 1);
        linkCount.set(e.b, (linkCount.get(e.b) || 0) + 1);
      }
      let anchor = [...nodes.nodes.values()][0];
      for (const n of nodes.nodes.values()) {
        if ((linkCount.get(n.data.id) || 0) < (linkCount.get(anchor.data.id) || 0)) anchor = n;
      }
      const pos = anchor.group.position.clone().add(new THREE.Vector3(0.35, 0.22, 0.1));
      nodes.createNode({ ...insight, category: 'insight' }, pos, aura.position.clone(), true);
      nodes.connect(insight.id, anchor.data.id);
      if (!reducedMotion) particles.burst(pos, 0xc2274d, 110, 0.8);
      selectedId = insight.id;
      sound.spawn();
    }
    aura.setState('speaking');
    voice.speak(response.spokenReply);
    markAi(live, provider);
    persistBoard();
    toast(`Review (${CRIT_LABELS[mode]}) complete — insight orb spawned.`);
    window.setTimeout(() => aura?.setState('idle'), 3200);
  } finally {
    setBusy(false);
  }
}

async function doDock(action: DockAction): Promise<void> {
  if (!nodes || !aura) return;
  dock?.flash(action);
  sound.click();
  if (action === 'voice') {
    voice.start();
  } else if (action === 'organize') {
    snapshot();
    nodes.autoOrganize(xrHome());
    sound.whoosh();
    persistBoard();
    setCaption('Board re-aligned by category.');
  } else if (action === 'blindspot') {
    await doCritique();
  } else if (action === 'export') {
    doExport();
  } else if (action === 'preset') {
    presetIdx = (presetIdx + 1) % PRESETS.length;
    toast(`Preset: ${PRESETS[presetIdx].name}`);
    await doGenerate(PRESETS[presetIdx].prompt);
  } else if (action === 'keyboard') {
    openKeyboardForGoal();
  } else if (action === 'boards') {
    toggleBoardPanel();
  } else if (action === 'recenter') {
    doRecenter();
  } else if (action === 'save') {
    const b = persistBoard(false);
    if (!b) toast('Nothing to save yet — create a board first.');
  }
}

/** Bring aura + board + dock back into a comfortable seated/standing arc. XR-only:
 *  on desktop the orbit camera owns the view, so just hint instead. */
function doRecenter(): void {
  if (!nodes || !aura || !dock || !keyboard || !boardPanel) return;
  if (!sceneManager.renderer.xr.isPresenting) {
    toast('Recenter applies in-headset — drag the background to orbit here.');
    return;
  }
  const r = reach();
  const cam = sceneManager.camera;
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
  dir.normalize();
  const center = cam.position.clone().addScaledVector(dir, r.dist);
  center.y = r.boardY;
  const old = aura.position.clone();
  const delta = center.clone().add(new THREE.Vector3(0, 0, -0.25)).sub(old);
  aura.group.position.add(delta);
  for (const n of nodes.nodes.values()) {
    n.group.position.add(delta);
    n.target.add(delta);
  }
  dock.placeInFront(cam, r.dist, r.dockY);
  keyboard.placeInFront(cam, r.dist, r.kbY);
  if (boardPanel.visible) boardPanel.placeInFront(cam, r.dist, -0.05);
  boardHome = center.clone();
  sceneManager.placeGround(center.x, center.z);
  dock.flash('recenter');
  sound.whoosh();
  setCaption(seated ? 'Workspace recentered — seated arc (close + low).' : 'Workspace recentered — standing arc (far + high).');
  toast('Workspace recentered.');
}

/** Hands-first goal entry: summon the in-headset keyboard. */
function openKeyboardForGoal(): void {
  if (!keyboard || !sceneManager) return;
  if (boardPanel?.visible) boardPanel.close();
  const r = reach();
  keyboard.placeInFront(sceneManager.camera, r.dist, r.kbY);
  keyboard.open('goal');
  setCaption('Poke letters to type your goal, then poke GO. Preset key fills an example.');
  sound.click();
}

function openKeyboardForEdit(mode: KeyboardMode): void {
  if (!nodes || !keyboard) return;
  const n = selectedId ? nodes.getNode(selectedId) : null;
  if (!n) { toast('Pinch-grab an orb first to select it.'); return; }
  if (boardPanel?.visible) boardPanel.close();
  const r = reach();
  keyboard.placeInFront(sceneManager.camera, r.dist, r.kbY);
  if (mode === 'title') keyboard.open('title', n.data.title, n.data.id);
  else if (mode === 'summary') keyboard.open('summary', n.data.summary, n.data.id);
  else keyboard.open('bullet', n.data.bullets[0] || '', n.data.id, 0);
  setCaption(`Editing "${n.data.title}" — poke GO to save.`);
  sound.click();
}

async function applyKeyboardSubmit(text: string): Promise<void> {
  if (!keyboard || !nodes) return;
  const clean = text.trim().slice(0, 120);
  const mode = keyboard.mode;
  const targetId = keyboard.targetNodeId;
  keyboard.close();
  if (!clean) { setCaption('Empty — nothing changed.'); return; }
  if (mode === 'goal') { await doGenerate(clean); return; }
  if (mode === 'rename') {
    boardName = clean.slice(0, 60);
    persistBoard(false);
    setCaption(`Board renamed to "${boardName}".`);
    return;
  }
  if (targetId) {
    const n = nodes.getNode(targetId);
    if (!n) return;
    snapshot();
    if (mode === 'title') n.data.title = clean.slice(0, 40);
    else if (mode === 'summary') n.data.summary = clean.slice(0, 90);
    else if (mode === 'bullet') n.data.bullets[0] = clean.slice(0, 90);
    nodes.refreshCard(targetId);
    selectedId = targetId;
    persistBoard();
    setCaption(`Saved "${n.data.title}".`);
    toast('Card updated and board saved.');
  }
}

function loadBoardIntoScene(b: SavedBoard): void {
  if (!nodes || !aura) return;
  const nm = nodes;
  const ac = aura;
  nm.clear();
  heldByHand.clear();
  merging.clear();
  clearUndo();
  stopPresent();
  onboarded = true;
  currentBoardId = b.id;
  boardName = b.name;
  const presenting = sceneManager.renderer.xr.isPresenting;
  const center = presenting
    ? (boardHome ? boardHome.clone() : new THREE.Vector3(0, reach().boardY, -0.85))
    : new THREE.Vector3(0, 1.3, -0.85);
  if (presenting) boardHome = center.clone();
  b.nodes.forEach((d) => {
    const saved = Array.isArray(d.pos) && d.pos.length === 3 &&
      d.pos.every((n) => typeof n === 'number' && Number.isFinite(n));
    const pos = saved
      ? new THREE.Vector3(
        THREE.MathUtils.clamp(d.pos![0], center.x - 1.2, center.x + 1.2),
        THREE.MathUtils.clamp(d.pos![1], 0.5, 2.2),
        THREE.MathUtils.clamp(d.pos![2], center.z - 1.0, center.z + 0.6))
      : (() => {
        const ang = b.nodes.length <= 1 ? 0 : ((b.nodes.indexOf(d)) / (b.nodes.length - 1) - 0.5) * 1.9;
        return new THREE.Vector3(center.x + Math.sin(ang) * 0.55, center.y - Math.abs(ang) * 0.12, center.z + 0.08);
      })();
    nm.createNode(d, pos, saved ? pos.clone() : ac.position.clone(), true);
  });
  for (const e of b.edges) nm.connect(e.a, e.b);
  selectedId = null;
  markSaved(b.updatedAt);
  refreshBoardPicker();
  setCaption(`Opened "${b.name}" — ${b.nodes.length} ideas restored.`);
}

/** Restore the last opened board. False when none exists or it is unusable. */
function restoreLastBoard(): boolean {
  if (!nodes) return false;
  const id = lastBoardId();
  if (!id) return false;
  const b = loadBoard(id);
  if (!b || !b.nodes.length) {
    if (id && !b) clearLastBoard();
    return false;
  }
  loadBoardIntoScene(b);
  return true;
}

/** Hands-only fresh start: empty board + keyboard ready for a goal. */
function startNewBoard(): void {
  if (!nodes || !keyboard) return;
  nodes.clear();
  heldByHand.clear();
  merging.clear();
  clearUndo();
  stopPresent();
  onboarded = true;
  currentBoardId = null;
  boardName = 'Untitled board';
  selectedId = null;
  markUnsaved();
  refreshBoardPicker();
  boardPanel?.close();
  openKeyboardForGoal();
  setCaption('New board — poke letters for your goal, then poke GO.');
}

/** Toggle the in-headset board manager (open/rename/delete with confirm). */
function toggleBoardPanel(): void {
  if (!boardPanel || !keyboard) return;
  if (boardPanel.visible) {
    boardPanel.close();
    setCaption('Boards closed.');
    sound.click();
    return;
  }
  keyboard.close();
  boardPanel.resetPage();
  boardPanel.refresh(listBoards(), currentBoardId, panelExtras());
  const r = reach();
  boardPanel.placeInFront(sceneManager.camera, r.dist, -0.05);
  boardPanel.open();
  sound.click();
  setCaption('Poke a board to open · ‹ › pages · + New · Rename / Delete act on the open board.');
}

function boardPanelAction(a: BoardPanelAction): void {
  if (!boardPanel || !keyboard || !nodes) return;
  sound.click();
  if (a.kind === 'close') { boardPanel.close(); setCaption('Boards closed.'); return; }
  if (a.kind === 'new') { boardPanel.resetPage(); startNewBoard(); return; }
  if (a.kind === 'page') { boardPanel.turnPage(a.dir); boardPanel.refresh(listBoards(), currentBoardId, panelExtras()); return; }
  if (a.kind === 'open') {
    const b = loadBoard(a.id);
    if (!b) { toast('That board is gone — pick another.'); boardPanel.refresh(listBoards(), currentBoardId, panelExtras()); return; }
    boardPanel.close();
    boardPanel.resetPage();
    loadBoardIntoScene(b);
    toast(`Opened "${b.name}".`);
    return;
  }
  if (a.kind === 'present') { togglePresent(); boardPanel.refresh(listBoards(), currentBoardId, panelExtras()); return; }
  if (a.kind === 'undo') { undo(); boardPanel.refresh(listBoards(), currentBoardId, panelExtras()); return; }
  if (a.kind === 'rename') {
    if (!currentBoardId) { toast('Open or create a board first.'); return; }
    boardPanel.close();
    keyboard.placeInFront(sceneManager.camera, reach().dist, reach().kbY);
    keyboard.open('rename', boardName);
    setCaption('Rename the board — poke GO to save.');
    return;
  }
  if (a.kind === 'delete') {
    if (!currentBoardId) return;
    if (!boardPanel.isArmedFor(currentBoardId)) {
      boardPanel.armDelete(currentBoardId);
      boardPanel.refresh(listBoards(), currentBoardId, panelExtras());
      setCaption('Poke the red CONFIRM row to permanently delete this board.');
      toast('Delete armed — poke CONFIRM within 6s, or poke elsewhere to cancel.');
      return;
    }
    const ok = deleteBoard(currentBoardId);
    boardPanel.close();
    boardPanel.resetPage();
    if (!ok) {
      markSaveFailed();
      toast('Delete failed — storage unavailable.');
      return;
    }
    toast(`Deleted "${boardName}".`);
    nodes.clear();
    heldByHand.clear();
    merging.clear();
    clearUndo();
    stopPresent();
    onboarded = true;
    currentBoardId = null;
    boardName = 'Untitled board';
    selectedId = null;
    markUnsaved();
    refreshBoardPicker();
    setCaption('Board deleted. Poke LIB for a saved board, or type a new goal.');
  }
}

function doDeleteSelected(): void {
  if (!nodes) return;
  const n = selectedId ? nodes.getNode(selectedId) : null;
  if (!n) { toast('Pinch-grab an orb first to select it.'); return; }
  if (n.data.id.startsWith('tut_')) { toast('Finish or skip the tutorial first.'); return; }
  snapshot();
  stopPresent();
  removeOrb(n.data.id);
  selectedId = null;
  persistBoard();
  sound.release();
  toast('Card deleted.');
}

function doExport(): void {
  if (!nodes) return;
  if (!nodes.nodes.size || !onboarded) {
    toast('Generate a board first, then export the action plan.');
    return;
  }
  dock?.flash('export');
  const md = buildMarkdown(nodes.getNodeData(), nodes.edges.map((e) => ({ a: e.a, b: e.b })));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `${boardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'auracanvas'}-plan-${stamp}.md`;
  const nav = navigator as Navigator & { share?: (d: { title: string; text: string }) => Promise<void> };
  // Quest Browser blocks programmatic downloads at times — prefer system share sheet.
  if (typeof nav.share === 'function') {
    nav.share({ title: 'AuraCanvas action plan', text: md }).then(
      () => toast('Action plan shared. Board stays saved on this device.'),
      () => {
        downloadMarkdown(filename, md);
        void copyMarkdown(md);
        toast('Action plan downloaded and copied to clipboard.');
      }
    );
  } else {
    downloadMarkdown(filename, md);
    void copyMarkdown(md).then((ok) => toast(ok
      ? 'Action plan downloaded and copied to clipboard.'
      : 'Action plan downloaded (clipboard blocked).'));
  }
  sound.click();
}

// Per-hand keyboard dwell state: hold fingertip on a key 350ms to type it,
// so the finger flying across the panel doesn't spray characters.
const kbDwellKey = ['', ''];
const kbDwellT = [0, 0];
/** Key that already fired for this hand: lift the finger before it can refire. */
const kbFired = ['', ''];

function keyboardDwellReset(hi: number): void {
  kbDwellKey[hi] = ''; kbDwellT[hi] = 0; kbFired[hi] = '';
  keyboard?.setDwellProgress(null, 0);
}

function keyboardDwell(p: THREE.Vector3, hi: number, dt: number, onTick: () => void): string | null {
  if (!keyboard || !keyboard.visible) { keyboardDwellReset(hi); return null; }
  const hovered = keyboardHover(p);
  if (!hovered) { keyboardDwellReset(hi); return null; }
  if (hovered === kbFired[hi]) {
    // Held down on the just-typed key: show full, wait for lift-off.
    kbDwellKey[hi] = ''; kbDwellT[hi] = 0;
    keyboard.setDwellProgress(hovered, 1);
    return null;
  }
  if (kbDwellKey[hi] !== hovered) { kbDwellKey[hi] = hovered; kbDwellT[hi] = 0; kbFired[hi] = ''; }
  kbDwellT[hi] += dt;
  onTick();
  keyboard.setDwellProgress(hovered, kbDwellT[hi] / 0.35);
  if (kbDwellT[hi] >= 0.35) {
    kbFired[hi] = hovered; kbDwellKey[hi] = ''; kbDwellT[hi] = 0;
    keyboard.setDwellProgress(null, 0);
    return keyboard.tryPoke(p, true, () => undefined);
  }
  keyboard.tryPoke(p, false, () => undefined);
  return null;
}

/** Nearest keyboard key label within poke radius, or null. */
function keyboardHover(p: THREE.Vector3): string | null {
  if (!keyboard || !keyboard.visible) return null;
  let best: string | null = null;
  let bd = 0.05;
  const tmp = new THREE.Vector3();
  for (const key of keyboard.keys) {
    key.getWorldPosition(tmp);
    const d = tmp.distanceTo(p);
    if (d < bd) { bd = d; best = (key.userData.keyAction as string) + '|' + (key.userData.keyLabel as string); }
  }
  return best;
}

// ---------- per-frame XR hand interaction ----------
function tick(dt: number, t: number, frame: unknown): void {
  if (!nodes || !aura || !particles || !dock || !hands || !keyboard || !boardPanel) return;
  const refSpace = sceneManager.renderer.xr.getReferenceSpace?.() ?? null;
  hands.update(frame, refSpace, dt);

  if (sceneManager.renderer.xr.isPresenting) {
    const ray = new THREE.Raycaster();
    hands.hands.forEach((h, hi) => {
      if (!h.present) { wasPinching[hi] = false; return; }
      // grab / release (hysteresis lives in HandInputManager; this is edge detect)
      if (h.pinching && !wasPinching[hi]) {
        const orb = nodes!.closestTo(h.pinchPos, 0.12);
        if (orb && ![...heldByHand.values()].includes(orb)) {
          heldByHand.set(hi, orb);
          orb.grabbed = true;
          orb.vel.set(0, 0, 0);
          orb.prev.copy(orb.group.position);
          orb.detail = true;
          selectedId = orb.data.id;
          nodes!.refreshCard(orb.data.id);
          sound.grab();
          sceneManager.pulseHaptics(0.5, 12);
        }
      } else if (!h.pinching && wasPinching[hi]) {
        const held = heldByHand.get(hi);
        if (held) {
          held.grabbed = false;
          sound.release();
          const other = nodes!.closestTo(held.group.position, 0.18, held);
          if (other) void doMerge(held, other);
          else {
            snapshot();
            // Inertial glide: a flick keeps drifting briefly instead of dead-stopping.
            const glide = held.vel.clone().multiplyScalar(0.12);
            if (glide.length() > 0.25) glide.setLength(0.25);
            held.target.copy(held.group.position).add(glide);
            held.target.x = THREE.MathUtils.clamp(held.target.x, -1.6, 1.6);
            held.target.y = THREE.MathUtils.clamp(held.target.y, 0.5, 2.3);
            held.target.z = THREE.MathUtils.clamp(held.target.z, -2.0, 0.3);
            held.vel.set(0, 0, 0);
            persistBoard(); // dropped/moved — save the new layout
          }
          heldByHand.delete(hi);
        }
      }
      wasPinching[hi] = h.pinching;
      const held = heldByHand.get(hi);
      if (held && h.pinching) {
        held.group.position.lerp(h.pinchPos, Math.min(dt * 18, 1));
        held.group.position.x = THREE.MathUtils.clamp(held.group.position.x, -1.6, 1.6);
        held.group.position.y = THREE.MathUtils.clamp(held.group.position.y, 0.5, 2.3);
        held.group.position.z = THREE.MathUtils.clamp(held.group.position.z, -2.0, 0.3);
        held.hoverT = 1;
        // one-handed drag-into-stationary fusion
        const other = nodes!.closestTo(held.group.position, 0.12, held);
        if (other && ![...heldByHand.values()].includes(other)) {
          void doMerge(held, other);
          heldByHand.delete(hi);
          held.grabbed = false;
        }
      }
      // two-handed proximity fusion
      const pair = nodes!.pairWithin(0.18);
      if (pair && !busy) {
        const heldList = [...heldByHand.values()];
        if (heldList.includes(pair[0]) || heldList.includes(pair[1])) {
          void doMerge(pair[0], pair[1]);
        }
      }
      // tether + hum when close while grabbing
      const near = nodes!.pairWithin(0.32);
      const anyHeld = heldByHand.size > 0;
      if (near && anyHeld && (heldByHand.has(hi) || [...heldByHand.values()].includes(near[0]) || [...heldByHand.values()].includes(near[1]))) {
        nodes!.setTether(near[0].group.position, near[1].group.position, 1 - near[0].group.position.distanceTo(near[1].group.position) / 0.32);
        if (performance.now() - lastHum > 280) {
          lastHum = performance.now();
          sound.pinchHum(1 - near[0].group.position.distanceTo(near[1].group.position) / 0.32);
        }
      } else if (hi === 0) {
        nodes!.clearTether();
      }
      // index poke: keyboard first, then dock buttons, aura, orbs
      if (!h.pinching) {
        const now = performance.now();
        if (keyboard!.visible) {
          const res = keyboardDwell(h.indexTip, hi, dt, () => sound.hover());
          if (res) {
            sound.click();
            if (res === 'submit') void applyKeyboardSubmit(keyboard!.value);
            else if (res === 'close') keyboard!.close();
            else if (res === 'preset') {
              presetIdx = (presetIdx + 1) % PRESETS.length;
              keyboard!.open('goal', PRESETS[presetIdx].prompt);
              setCaption(`Preset filled: ${PRESETS[presetIdx].name} — poke GO.`);
            }
          }
        }
        // board panel poke (LIB manager: open / new / rename / delete-confirm)
        if (boardPanel!.visible) {
          const act = boardPanel!.tryPoke(h.indexTip);
          if (act) {
            const key = 'panel_' + act.kind + ('id' in act && act.id ? '_' + act.id : '') + ('dir' in act && act.dir ? '_' + String(act.dir) : '');
            if (now - (pokeCooldown.get(key) || 0) > 800) {
              pokeCooldown.set(key, now);
              sound.click();
              sceneManager.pulseHaptics(0.35, 10);
              boardPanelAction(act);
            }
          }
        }
        // dock poke (forgiving 9cm targets, 1.2s cooldown)
        for (const b of dock!.buttons) {
          const bp = new THREE.Vector3();
          b.getWorldPosition(bp);
          if (bp.distanceTo(h.indexTip) < 0.09) {
            const key = 'dock_' + (b.userData.dockAction as string);
            if (now - (pokeCooldown.get(key) || 0) > 1200) {
              pokeCooldown.set(key, now);
              sound.click();
              sceneManager.pulseHaptics(0.4, 12);
              void doDock(b.userData.dockAction as DockAction);
            }
          }
        }
        // aura poke → critique
        if (aura!.position.distanceTo(h.indexTip) < 0.18) {
          if (now - (pokeCooldown.get('aura') || 0) > 2000) {
            pokeCooldown.set('aura', now);
            sound.click();
            sceneManager.pulseHaptics(0.5, 14);
            void doCritique();
          }
        } else if (!keyboard!.visible) {
          // orb poke → select + expand (suppressed while typing)
          const orb = nodes!.closestTo(h.indexTip, 0.075);
          if (orb) {
            orb.hoverT = 1;
            selectedId = orb.data.id;
            const key = 'poke_' + orb.data.id;
            if (now - (pokeCooldown.get(key) || 0) > 1500) {
              pokeCooldown.set(key, now);
              sound.click();
              void doExpand(orb);
            }
          }
        }
      }
      void ray;
    });
  } else {
    // desktop magnetic tether while dragging
    const dragged = desktop?.getDragged() ?? null;
    if (dragged) {
      const other = nodes.closestTo(dragged.group.position, 0.32, dragged);
      if (other) {
        nodes.setTether(dragged.group.position, other.group.position, 1 - dragged.group.position.distanceTo(other.group.position) / 0.32);
        if (performance.now() - lastHum > 300) {
          lastHum = performance.now();
          sound.pinchHum(0.5);
        }
      } else nodes.clearTether();
    }
  }

  // Head-direction dwell fallback (NOT eye tracking): only when presenting
  // with no tracked hands. Covers keyboard keys, board panel, dock, orbs.
  if (sceneManager.renderer.xr.isPresenting && keyboard && boardPanel) {
    const anyHand = hands.hands.some((h) => h.present);
    if (!anyHand) runGazeDwell(dt);
    else {
      gaze.target = ''; gaze.time = 0; gazeLatch = '';
      keyboard.setDwellProgress(null, 0);
    }
  }

  // keep the selected card visually distinct hands-free
  if (selectedId && nodes) {
    const sel = nodes.getNode(selectedId);
    if (sel) sel.hoverT = Math.max(sel.hoverT, 0.55);
  }

  // Narrated walkthrough stepping: highlight, focus, caption, speak per node.
  if (present.on && nodes) {
    const n = present.order.length ? nodes.getNode(present.order[present.idx] ?? '') : undefined;
    if (!n) {
      stopPresent(present.idx >= present.order.length ? 'Walkthrough complete.' : 'Present mode ended.');
    } else {
      n.hoverT = 1;
      selectedId = n.data.id;
      if (present.timer === 0) {
        setFocusMode(n.data.id);
        setCaption(`${present.idx + 1}/${present.order.length} · ${n.data.title}: ${n.data.summary}`);
        voice.speak(`${n.data.title}. ${n.data.summary}. ${n.data.bullets.slice(0, 2).join('. ')}`);
      }
      present.timer += dt;
      if (present.timer >= PRESENT_STEP) {
        present.timer = 0;
        present.idx++;
        if (present.idx >= present.order.length) stopPresent('Walkthrough complete.');
      }
    }
  }

  nodes.update(dt, sceneManager.camera, t);
  aura.update(dt, t, voice.isListening ? 0.5 + Math.random() * 0.5 : 0);
  dock.followUser(sceneManager.camera, dt);
  dock.update(dt, t);
  keyboard.update(dt);
  if (!reducedMotion) particles.update(dt);
}

// Head-pointing dwell state shared by all gaze targets.
let gazeLatch = '';

/**
 * Generic dwell step: hold on one target id for `dwell` seconds to fire.
 * After firing, the same target cannot refire until gaze leaves it.
 */
function gazeDwellStep(id: string, dt: number, dwell: number, onFire: () => void, onProgress?: (p: number) => void): void {
  if (!id || id === gazeLatch) {
    if (!id) gazeLatch = '';
    gaze.target = ''; gaze.time = 0;
    onProgress?.(0);
    return;
  }
  if (gaze.target !== id) { gaze.target = id; gaze.time = 0; }
  gaze.time += dt;
  onProgress?.(Math.min(gaze.time / dwell, 1));
  if (gaze.time >= dwell) {
    gazeLatch = id; gaze.target = ''; gaze.time = 0;
    onProgress?.(0);
    onFire();
  }
}

/**
 * Head-pointing dwell: center-ray from the headset, hold to trigger.
 * Labelled as head-direction in UI; never described as eye tracking.
 * Supports the keyboard (typing), board panel, dock, orbs, and Aura.
 */
function runGazeDwell(dt: number): void {
  if (!nodes || !dock || !aura || !keyboard || !boardPanel) return;
  const nm = nodes;
  const kb = keyboard;
  const bp = boardPanel;
  const cam = sceneManager.camera;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), cam);
  // 1) keyboard typing via head-ray
  if (kb.visible) {
    const hit = kb.rayHit(ray);
    const id = hit ? 'key:' + hit.id : '';
    const point = hit ? hit.point : null;
    gazeDwellStep(id, dt, GAZE_KEY_DWELL,
      () => {
        if (!point) return;
        sound.click();
        const res = kb.tryPoke(point, true, () => undefined);
        if (res === 'submit') void applyKeyboardSubmit(kb.value);
        else if (res === 'close') kb.close();
        else if (res === 'preset') {
          presetIdx = (presetIdx + 1) % PRESETS.length;
          kb.open('goal', PRESETS[presetIdx].prompt);
          setCaption(`Preset filled: ${PRESETS[presetIdx].name} — hold GO to submit.`);
        }
      },
      (p) => kb.setDwellProgress(hit ? hit.id : null, p));
    return;
  }
  // 2) board panel rows via head-ray
  if (bp.visible) {
    const act = bp.rayHit(ray);
    const id = act ? 'panel:' + act.kind + ('id' in act && act.id ? ':' + act.id : '') + ('dir' in act && act.dir ? ':' + String(act.dir) : '') : '';
    gazeDwellStep(id, dt, GAZE_DWELL,
      () => { if (act) { sound.click(); boardPanelAction(act); } });
    return;
  }
  // 3) dock buttons, orbs, aura
  const dockHit = dock.tryHit(ray);
  let id = '';
  if (dockHit) id = 'dock_' + dockHit;
  else {
    const orb = nm.pick(ray);
    if (orb) id = 'orb_' + orb.data.id;
    else if (ray.ray.distanceToPoint(aura.position) < 0.18) id = 'aura';
  }
  gazeDwellStep(id, dt, GAZE_DWELL,
    () => {
      sound.click();
      if (id === 'aura') void doCritique();
      else if (id.startsWith('dock_')) void doDock(id.slice(5) as DockAction);
      else if (id.startsWith('orb_')) {
        const orb = nm.getNode(id.slice(4));
        if (orb) { selectedId = orb.data.id; void doExpand(orb); }
      }
    });
}

// ---------- controller fallback (Touch trigger reuses the fingertip poke path) ----------
function controllerSelect(_side: number, origin: THREE.Vector3, dir: THREE.Vector3): void {
  if (!nodes || !dock || !aura || !keyboard || !boardPanel) return;
  if (!sceneManager.renderer.xr.isPresenting || busy) return;
  const ray = new THREE.Raycaster(origin, dir.clone().normalize(), 0.05, 4);
  const now = performance.now();
  const fire = (key: string, cooldown: number, fn: () => void): void => {
    if (now - (pokeCooldown.get(key) || 0) < cooldown) return;
    pokeCooldown.set(key, now);
    sound.click();
    sceneManager.pulseHaptics(0.4, 12);
    fn();
  };
  // 1) keyboard keys
  if (keyboard.visible) {
    const hit = keyboard.rayHit(ray);
    if (hit && hit.point.distanceTo(origin) < 3) {
      const res = keyboard.tryPoke(hit.point, true, () => undefined);
      sound.click();
      if (res === 'submit') void applyKeyboardSubmit(keyboard.value);
      else if (res === 'close') keyboard.close();
      else if (res === 'preset') {
        presetIdx = (presetIdx + 1) % PRESETS.length;
        keyboard.open('goal', PRESETS[presetIdx].prompt);
        setCaption(`Preset filled: ${PRESETS[presetIdx].name} — poke GO.`);
      }
      sceneManager.pulseHaptics(0.35, 10);
      return;
    }
  }
  // 2) board panel rows
  if (boardPanel.visible) {
    const act = boardPanel.rayHit(ray);
    if (act) {
      fire('panel_' + act.kind + ('id' in act && act.id ? '_' + act.id : ''), 800, () => boardPanelAction(act));
      return;
    }
  }
  // 3) dock buttons
  const dockHit = dock.tryHit(ray);
  if (dockHit) {
    fire('dock_' + dockHit, 1200, () => void doDock(dockHit));
    return;
  }
  // 4) aura core
  if (ray.ray.distanceToPoint(aura.position) < 0.18) {
    fire('aura', 2000, () => void doCritique());
    return;
  }
  // 5) orbs within reach of the ray
  if (!keyboard.visible) {
    const orb = nodes.pick(ray);
    if (orb && orb.group.position.distanceTo(origin) < 3) {
      selectedId = orb.data.id;
      fire('poke_' + orb.data.id, 1500, () => void doExpand(orb));
    }
  }
}

// ---------- session launchers ----------
async function launchDesktop(): Promise<void> {
  sound.ensure();
  $('landing').classList.add('hidden');
  $('hud').classList.remove('hidden');
  ensureWorld(false);
  refreshBoardPicker();
  if (!restoreLastBoard()) spawnOnboarding();
  else setCaption('Last board restored — drag orbs, double-click to expand.');
}

async function launchXR(mode: 'immersive-ar' | 'immersive-vr'): Promise<void> {
  sound.ensure();
  ensureWorld(mode === 'immersive-ar');
  const ok = await sceneManager.startXR(mode);
  if (!ok) {
    toast(mode === 'immersive-ar'
      ? 'AR session blocked — use IWE extension or Desktop 3D'
      : 'VR session blocked — try Desktop 3D');
    return;
  }
  $('landing').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (!nodes!.nodes.size) {
    if (!restoreLastBoard()) spawnOnboarding();
  }
  refreshBoardPicker();
  toast(mode === 'immersive-ar' ? 'Passthrough mixed reality active.' : 'VR studio active.');
  setCaption('Pinch to grab orbs · ABC to type · LIB for saved boards · hold head still as backup');
}

// ---------- wiring ----------
function wireLanding(): void {
  ($('toggleSeated') as HTMLInputElement).checked = seated;
  $('btnDesktop').addEventListener('click', () => void launchDesktop());
  $('btnAR').addEventListener('click', () => void launchXR('immersive-ar'));
  $('btnVR').addEventListener('click', () => void launchXR('immersive-vr'));
  $('toggleCaptions').addEventListener('change', (e) => {
    captionsOn = (e.target as HTMLInputElement).checked;
  });
  $('toggleSeated').addEventListener('change', (e) => {
    seated = (e.target as HTMLInputElement).checked;
    saveSeatedPref(seated);
    toast(seated
      ? 'Seated: workspace close + low (68cm reach).'
      : 'Standing: workspace farther + higher (95cm reach).');
    if (worldReady && sceneManager.renderer.xr.isPresenting) doRecenter();
  });

  void SceneManager.isSupported('immersive-ar').then((s) => {
    const el = $('arSupport');
    el.textContent = s ? '● AR ready' : '○ AR not detected (IWE?)';
    if (s) el.classList.add('ok');
    if (!s) ($('btnAR') as HTMLButtonElement).disabled = false; // still try — IWE may inject late
  });
  void SceneManager.isSupported('immersive-vr').then((s) => {
    const el = $('vrSupport');
    el.textContent = s ? '● VR ready' : '○ VR not detected';
    if (s) el.classList.add('ok');
  });
  refreshAiBadge();
}

function wireHud(): void {
  const input = $('promptInput') as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      sound.ensure();
      void doGenerate(input.value.trim());
      input.value = '';
    }
  });
  $('micBtn').addEventListener('click', () => {
    sound.ensure();
    if (!voice.supported) {
      toast('Mic unavailable — type below, or use ABC in-headset.');
      setCaption('Microphone unavailable here — type your goal instead.');
    }
    voice.start();
  });
  $('btnOrganize').addEventListener('click', () => void doDock('organize'));
  $('btnBlind').addEventListener('click', () => void doDock('blindspot'));
  $('btnExport').addEventListener('click', () => doExport());
  $('btnSave').addEventListener('click', () => {
    const b = persistBoard(false);
    if (!b) toast('Nothing to save yet — create a board first.');
  });
  $('btnSkip').addEventListener('click', () => skipTutorial());
  const hideBtn = $('btnHide');
  const toggleHide = (): void => {
    document.body.classList.toggle('hide-ui');
    hideBtn.textContent = document.body.classList.contains('hide-ui') ? 'Show UI' : 'Hide UI';
  };
  hideBtn.addEventListener('click', toggleHide);
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'h' || e.key === 'H') && (e.target as HTMLElement)?.tagName !== 'INPUT') toggleHide();
  });
  $('btnEditTitle').addEventListener('click', () => openKeyboardForEdit('title'));
  $('btnEditSummary').addEventListener('click', () => openKeyboardForEdit('summary'));
  $('btnEditBullet').addEventListener('click', () => openKeyboardForEdit('bullet'));
  $('btnDelete').addEventListener('click', () => doDeleteSelected());
  $('btnUndo').addEventListener('click', () => undo());
  $('btnPresent').addEventListener('click', () => togglePresent());
  $('btnFocus').addEventListener('click', () => toggleFocus());
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFocus(); }
  });
  $('btnRename').addEventListener('click', () => {
    if (!keyboard) return;
    const r = reach();
    keyboard.placeInFront(sceneManager.camera, r.dist, r.kbY);
    keyboard.open('rename', boardName);
    setCaption('Rename the board — poke GO to save.');
  });
  $('boardSelect').addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (!id) return;
    const b = loadBoard(id);
    if (b) loadBoardIntoScene(b);
  });
  $('btnReset').addEventListener('click', () => { spawnOnboarding(); toast('Tutorial restarted.'); });
  $('btnMute').addEventListener('click', (e) => {
    muted = !muted;
    sound.setMuted(muted);
    voice.setMuted(muted);
    ($('btnMute') as HTMLElement).style.opacity = muted ? '0.35' : '1';
  });
  $('btnHome').addEventListener('click', () => {
    $('hud').classList.add('hidden');
    $('landing').classList.remove('hidden');
    refreshAiBadge();
  });
  const pills = $('presetPills');
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p.name.split(' ')[0];
    b.title = p.name;
    b.addEventListener('click', () => { sound.ensure(); void doGenerate(p.prompt); });
    pills.appendChild(b);
  });
}

wireLanding();
wireHud();

// Debug/testing handle (used by automated smoke tests; harmless in production).
(window as unknown as { __auracanvas: unknown }).__auracanvas = {
  get sceneManager() { return sceneManager; },
  get nodes() { return nodes; },
  get aura() { return aura; },
  get keyboard() { return keyboard; },
  get boardPanel() { return boardPanel; },
  doGenerate, doMerge, doExpand, doCritique, spawnOnboarding,
  skipTutorial, doRecenter, persistBoard, listBoards,
  toggleBoardPanel, startNewBoard, providerLabel, boardPanelAction,
  undo, togglePresent, toggleFocus, snapshot
};
