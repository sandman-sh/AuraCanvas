import type { AgentAction, AgentActionResponse, AgentRequest, CritiqueMode, IdeaNodeData } from '../types/graph';
import { uid } from '../types/graph';
import { localGenerate, localMerge, localExpand, localCritique } from './localAgentEngine';

/* ---------- plain-language engine names (no model codes in the UI) ---------- */

export function friendlyAiName(provider: string, model = ''): string {
  const m = (model || '').toLowerCase();
  if (m.includes('wonder')) return 'Muse Wonder';
  if (m.includes('ember')) return 'Muse Ember';
  if (m.includes('spark')) return 'Muse Spark';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'openai') return 'GPT';
  if (provider === 'meta' || provider === 'meta-direct' || provider === 'server') return 'Muse Spark';
  return 'Offline';
}

export interface ServerAiStatus {
  mode: 'meta' | 'gemini' | 'openai' | 'local';
  model: string;
}

let statusCache: { at: number; value: ServerAiStatus } | null = null;
let statusFlight: Promise<ServerAiStatus> | null = null;
const STATUS_TTL = 60000;

/** Which server engine is configured — costs no tokens, never exposes the key. */
export function getServerAiStatus(): Promise<ServerAiStatus> {
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL) return Promise.resolve(statusCache.value);
  if (statusFlight) return statusFlight;
  statusFlight = (async (): Promise<ServerAiStatus> => {
    try {
      const res = await fetch('/api/agent', { method: 'GET' });
      if (!res.ok) throw new Error('status ' + res.status);
      const data = (await res.json()) as { mode?: string; model?: string };
      const mode = data.mode === 'meta' || data.mode === 'gemini' || data.mode === 'openai' ? data.mode : 'local';
      const value: ServerAiStatus = { mode, model: typeof data.model === 'string' ? data.model : '' };
      statusCache = { at: Date.now(), value };
      return value;
    } catch {
      const value: ServerAiStatus = { mode: 'local', model: '' };
      statusCache = { at: Date.now(), value };
      return value;
    } finally {
      statusFlight = null;
    }
  })();
  return statusFlight;
}

/* ---------- Meta Muse prompt ---------- */

const SYSTEM = `You are Aura, a spatial mind-map agent for a Meta Quest mixed-reality app.
Always reply with strict JSON only, no prose outside JSON:
{"spokenReply": string (<=18 words), "nodes": [{"id": string, "title": string (<=5 words), "summary": string (<=14 words), "bullets": string[2-3 each <=8 words], "category": "goal|strategy|product|growth|risk|synthesis|insight"}], "connectToIds"?: string[]}
Categories: goal=central aim, strategy=plan of action, product=feature or artefact, growth=traction channel, risk=danger or blocker, synthesis=golden merged plan, insight=missing-angle critique.`;

function taskFor(req: AgentRequest): string {
  const prompt = (req.prompt || '').slice(0, 500);
  const nodes = JSON.stringify((req.existingNodes || []).slice(0, 30));
  if (req.action === 'merge' && req.mergePair) {
    return `MERGE these two ideas into ONE golden synthesis node with 3 concrete action bullets:\nA=${JSON.stringify(req.mergePair[0])}\nB=${JSON.stringify(req.mergePair[1])}\nReturn 1 node with category "synthesis", connectToIds=[both ids].`;
  }
  if (req.action === 'expand' && req.focusNode) {
    return `EXPAND this node into 2-3 concrete child sub-task nodes fanning out:\nFOCUS=${JSON.stringify(req.focusNode)}\nReturn 2-3 nodes, connectToIds=[focus id].`;
  }
  if (req.action === 'critique') {
    const mode = req.mode || 'blindspot';
    const lens = mode === 'premortem'
      ? 'Assume the goal has already FAILED. Name the single likeliest cause and one guardrail.'
      : mode === 'fivewhys'
        ? 'Drill to the root cause: name the deepest why behind the weakest area and the fix.'
        : 'Find the single most important missing angle (risk, growth, or first shippable slice).';
    return `CRITIQUE (${mode}) this mind-map. Board=${nodes}\n${lens} Return exactly 1 node with category "insight".`;
  }
  return `GENERATE a mind-map constellation for the goal: "${prompt}".\nReturn exactly 5 nodes: node[0] is the goal (category "goal"), then 4 branches covering strategy, product, growth, risk.`;
}

/* ---------- response sanitizer ---------- */

const ALLOWED = ['goal', 'strategy', 'product', 'growth', 'risk', 'synthesis', 'insight'] as const;

function cleanNode(o: unknown, fallbackCat: string): IdeaNodeData | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const title = String(r['title'] || '').slice(0, 40) || 'Untitled idea';
  const summary = String(r['summary'] || '').slice(0, 90) || title;
  const rawBullets = Array.isArray(r['bullets']) ? (r['bullets'] as unknown[]) : [];
  const bullets = rawBullets.map((b) => String(b).slice(0, 90)).filter(Boolean).slice(0, 3);
  while (bullets.length < 2) bullets.push('Define the next concrete step');
  const cat = ALLOWED.includes(r['category'] as (typeof ALLOWED)[number])
    ? (r['category'] as IdeaNodeData['category'])
    : (ALLOWED.includes(fallbackCat as (typeof ALLOWED)[number]) ? (fallbackCat as IdeaNodeData['category']) : 'strategy');
  return { id: String(r['id'] || uid('n')), title, summary, bullets, category: cat };
}

function sanitize(parsed: unknown, action: AgentAction): AgentActionResponse | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p['nodes']) || typeof p['spokenReply'] !== 'string') return null;
  const fallback = action === 'merge' ? 'synthesis' : action === 'critique' ? 'insight' : 'strategy';
  const nodes = (p['nodes'] as unknown[]).map((n) => cleanNode(n, fallback)).filter((n): n is IdeaNodeData => n !== null);
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const connectToIds = Array.isArray(p['connectToIds'])
    ? (p['connectToIds'] as unknown[]).map(String).filter((id) => ids.has(id) || true).slice(0, 8)
    : undefined;
  return { spokenReply: String(p['spokenReply']).slice(0, 140), nodes, connectToIds };
}

function extractJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through */ } }
  return null;
}

/* ---------- server route (key stays server-side) + offline fallback ---------- */

async function callServerless(req: AgentRequest): Promise<{ response: AgentActionResponse; provider: string }> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req)
  });
  if (!res.ok) throw new Error(`agent http ${res.status}`);
  const data = (await res.json()) as AgentActionResponse & { provider?: string; useClientKey?: boolean };
  if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) throw new Error('no server nodes');
  return { response: data, provider: data.provider || 'server' };
}

function runLocal(req: AgentRequest): AgentActionResponse {
  if (req.action === 'merge' && req.mergePair) return localMerge(req.mergePair[0], req.mergePair[1]);
  if (req.action === 'expand' && req.focusNode) return localExpand(req.focusNode);
  if (req.action === 'critique') return localCritique(req.existingNodes || [], req.mode || 'blindspot');
  return localGenerate(req.prompt);
}

export type AgentOutcome = { response: AgentActionResponse; live: boolean; provider: string };

/** Main entry: server route first (uses the .env key), offline engine fallback. Never throws. */
export async function runAgent(
  action: AgentAction,
  prompt: string,
  opts: { existingNodes?: IdeaNodeData[]; focusNode?: IdeaNodeData; mergePair?: [IdeaNodeData, IdeaNodeData]; critiqueMode?: CritiqueMode } = {}
): Promise<AgentOutcome> {
  const req: AgentRequest = {
    action, prompt,
    existingNodes: opts.existingNodes,
    focusNode: opts.focusNode,
    mergePair: opts.mergePair,
    mode: opts.critiqueMode
  };
  try {
    const { response, provider } = await callServerless(req);
    return { response, live: true, provider };
  } catch {
    return { response: runLocal(req), live: false, provider: 'local' };
  }
}
