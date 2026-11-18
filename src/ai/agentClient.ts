import type { AgentAction, AgentActionResponse, AgentRequest, CritiqueMode, IdeaNodeData } from '../types/graph';
import { uid } from '../types/graph';
import { localGenerate, localMerge, localExpand, localCritique } from './localAgentEngine';

export const META_BASE_URL = 'https://api.meta.ai/v1';
export const META_MODELS = ['muse-spark-1.3', 'muse-wonder-1.0', 'muse-ember-1.0'] as const;
export const DEFAULT_META_MODEL = 'muse-spark-1.3';

const KEY_STORE = 'auracanvas_meta_key';
const MODEL_STORE = 'auracanvas_meta_model';

/* ---------- stored settings (localStorage so the key survives reloads) ---------- */

export function getStoredKey(): string {
  try {
    return (
      localStorage.getItem(KEY_STORE) ||
      sessionStorage.getItem('auracanvas_api_key') || // legacy location
      ''
    ).trim();
  } catch { return ''; }
}

export function setStoredKey(key: string): void {
  try {
    if (key) {
      localStorage.setItem(KEY_STORE, key);
      sessionStorage.removeItem('auracanvas_api_key');
    } else {
      localStorage.removeItem(KEY_STORE);
      sessionStorage.removeItem('auracanvas_api_key');
    }
  } catch { /* ignore */ }
}

export function getStoredModel(): string {
  try {
    const m = localStorage.getItem(MODEL_STORE) || '';
    if ((META_MODELS as readonly string[]).includes(m)) return m;
  } catch { /* ignore */ }
  return DEFAULT_META_MODEL;
}

export function setStoredModel(model: string): void {
  try {
    if ((META_MODELS as readonly string[]).includes(model)) localStorage.setItem(MODEL_STORE, model);
  } catch { /* ignore */ }
}

export function aiModeLabel(): string {
  if (getStoredKey()) return `Meta Muse Ready (${getStoredModel()})`;
  return 'Offline Agent — live AI optional';
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

/* ---------- Meta Muse direct call (browser -> api.meta.ai, OpenAI-compatible) ---------- */

async function callMetaDirect(req: AgentRequest, apiKey: string, model: string): Promise<AgentActionResponse> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(`${META_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 2600,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: taskFor(req) }
        ]
      })
    });
    if (!res.ok) throw new Error(`meta ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || '';
    const parsed = extractJson(text);
    const clean = sanitize(parsed, req.action);
    if (!clean) throw new Error('meta bad shape');
    return clean;
  } finally {
    window.clearTimeout(timer);
  }
}

/* ---------- serverless fallback (same providers, key kept server-side) ---------- */

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

/** Main entry: Meta Muse direct -> serverless -> offline engine. Never throws. */
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
  const key = getStoredKey();
  if (key) {
    try {
      const response = await callMetaDirect(req, key, getStoredModel());
      return { response, live: true, provider: 'meta-direct' };
    } catch { /* fall through to serverless, then local */ }
  }
  try {
    const { response, provider } = await callServerless(req);
    return { response, live: true, provider };
  } catch {
    return { response: runLocal(req), live: false, provider: 'local' };
  }
}

/** Validate a key + model against Meta before saving. Returns null on success, error text otherwise. */
export async function testMetaConnection(apiKey: string, model: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(`${META_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify({
          model,
          max_tokens: 60,
          messages: [{ role: 'user', content: 'Reply with the exact JSON {"ok":true}.' }]
        })
      });
      if (res.status === 401 || res.status === 403) return 'Key rejected (401/403). Check the key at dev.meta.ai.';
      if (res.status === 404) return 'Model not found (404). Try muse-spark-1.3.';
      if (!res.ok) return `Meta API error ${res.status}. Try again in a moment.`;
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  } catch {
    return 'Network error reaching api.meta.ai. Check connection and try again.';
  }
}
