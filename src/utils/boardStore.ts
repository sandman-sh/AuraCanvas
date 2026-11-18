import type { IdeaNodeData } from '../types/graph';

export interface SavedBoard {
  id: string;
  name: string;
  updatedAt: number;
  nodes: IdeaNodeData[];
  edges: { a: string; b: string }[];
}

const KEY = 'auracanvas_boards_v1';
const LAST_KEY = 'auracanvas_last_board';
const SEAT_KEY = 'auracanvas_seated';

function validNodeData(d: unknown): d is IdeaNodeData {
  if (!d || typeof d !== 'object') return false;
  const r = d as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['title'] !== 'string' ||
    typeof r['summary'] !== 'string' || !Array.isArray(r['bullets']) || typeof r['category'] !== 'string') return false;
  const pos = r['pos'];
  if (pos !== undefined) {
    if (!Array.isArray(pos) || pos.length !== 3) return false;
    if (!(pos as unknown[]).every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  }
  return true;
}

function validBoard(b: unknown): b is SavedBoard {
  if (!b || typeof b !== 'object') return false;
  const r = b as Record<string, unknown>;
  return typeof r['id'] === 'string' && typeof r['name'] === 'string' &&
    typeof r['updatedAt'] === 'number' &&
    Array.isArray(r['nodes']) && (r['nodes'] as unknown[]).every(validNodeData) &&
    Array.isArray(r['edges']);
}

/** False when localStorage is missing or unwritable (private mode, quota, etc). */
export function storageAvailable(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const k = '__auracanvas_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

/** Malformed entries are dropped (and rewritten clean) instead of crashing callers. */
function readAll(): SavedBoard[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const good = arr.filter(validBoard);
    if (good.length !== arr.length) {
      try { localStorage.setItem(KEY, JSON.stringify(good.slice(0, 24))); } catch { /* ignore */ }
    }
    return good;
  } catch { return []; }
}

/** Returns false when the write failed (quota/unavailable). Never throws. */
function writeAll(boards: SavedBoard[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(boards.slice(0, 24)));
    return true;
  } catch { return false; }
}

export function listBoards(): SavedBoard[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SaveResult { board: SavedBoard | null; ok: boolean }

export function saveBoard(name: string, nodes: IdeaNodeData[], edges: { a: string; b: string }[], id?: string): SaveResult {
  if (!storageAvailable()) return { board: null, ok: false };
  const boards = readAll();
  const clean = (name || 'Untitled board').trim().slice(0, 60) || 'Untitled board';
  if (id) {
    const ex = boards.find((b) => b.id === id);
    if (ex) {
      ex.name = clean; ex.nodes = nodes; ex.edges = edges; ex.updatedAt = Date.now();
      const ok = writeAll(boards);
      if (ok) { try { localStorage.setItem(LAST_KEY, ex.id); } catch { /* ignore */ } }
      return { board: ex, ok };
    }
  }
  const board: SavedBoard = {
    id: id || `board_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`,
    name: clean, updatedAt: Date.now(), nodes, edges
  };
  boards.push(board);
  const ok = writeAll(boards);
  if (ok) { try { localStorage.setItem(LAST_KEY, board.id); } catch { /* ignore */ } }
  return { board, ok };
}

export function loadBoard(id: string): SavedBoard | null {
  return readAll().find((b) => b.id === id) || null;
}

export function lastBoardId(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

export function clearLastBoard(): void {
  try { localStorage.removeItem(LAST_KEY); } catch { /* ignore */ }
}

/** Returns false when the delete could not be persisted. Never throws. */
export function deleteBoard(id: string): boolean {
  if (!storageAvailable()) return false;
  const ok = writeAll(readAll().filter((b) => b.id !== id));
  if (ok) {
    try { if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY); } catch { /* ignore */ }
  }
  return ok;
}

export function renameBoard(id: string, name: string): boolean {
  if (!storageAvailable()) return false;
  const boards = readAll();
  const b = boards.find((x) => x.id === id);
  if (!b) return false;
  b.name = (name || b.name).slice(0, 60); b.updatedAt = Date.now();
  return writeAll(boards);
}

export function loadSeatedPref(): boolean {
  try { return localStorage.getItem(SEAT_KEY) !== 'standing'; } catch { return true; }
}

export function saveSeatedPref(seated: boolean): void {
  try { localStorage.setItem(SEAT_KEY, seated ? 'seated' : 'standing'); } catch { /* ignore */ }
}
