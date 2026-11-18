import { localGenerate, localMerge, localExpand, localCritique } from '../src/ai/localAgentEngine';

declare const process: { env: Record<string, string | undefined> };

interface AgentBody {
  action?: 'generate' | 'merge' | 'expand' | 'critique';
  prompt?: string;
  mode?: 'blindspot' | 'premortem' | 'fivewhys';
  existingNodes?: Array<{ id: string; title: string; summary: string; bullets: string[]; category: string }>;
  focusNode?: { id: string; title: string; summary: string; bullets: string[]; category: string };
  mergePair?: [{ id: string; title: string; summary: string; bullets: string[]; category: string }, { id: string; title: string; summary: string; bullets: string[]; category: string }];
}

type Req = { method?: string; body?: AgentBody };
type Res = { status(code: number): Res; json(obj: unknown): void };

const META_BASE = 'https://api.meta.ai/v1';
const META_DEFAULT_MODEL = 'muse-spark-1.3';

const SYSTEM = `You are Aura, a spatial mind-map agent for a Meta Quest mixed-reality app.
Always reply with strict JSON only, no prose outside JSON:
{"spokenReply": string (<=18 words), "nodes": [{"id": string, "title": string (<=5 words), "summary": string (<=14 words), "bullets": string[2-3 each <=8 words], "category": "goal|strategy|product|growth|risk|synthesis|insight"}], "connectToIds"?: string[]}
Categories: goal=central aim, strategy=plan of action, product=feature or artefact, growth=traction channel, risk=danger or blocker, synthesis=golden merged plan, insight=missing-angle critique.`;

function taskFor(body: AgentBody): string {
  const prompt = (body.prompt || '').slice(0, 500);
  const nodes = JSON.stringify((body.existingNodes || []).slice(0, 30));
  if (body.action === 'merge' && body.mergePair) {
    return `MERGE these two ideas into ONE golden synthesis node with 3 concrete action bullets:\nA=${JSON.stringify(body.mergePair[0])}\nB=${JSON.stringify(body.mergePair[1])}\nReturn 1 node with category "synthesis", connectToIds=[both ids].`;
  }
  if (body.action === 'expand' && body.focusNode) {
    return `EXPAND this node into 2-3 concrete child sub-task nodes fanning out:\nFOCUS=${JSON.stringify(body.focusNode)}\nReturn 2-3 nodes, connectToIds=[focus id].`;
  }
  if (body.action === 'critique') {
    const mode = body.mode || 'blindspot';
    const lens = mode === 'premortem'
      ? 'Assume the goal has already FAILED. Name the single likeliest cause and one guardrail.'
      : mode === 'fivewhys'
        ? 'Drill to the root cause: name the deepest why behind the weakest area and the fix.'
        : 'Find the single most important missing angle (risk, growth, or first shippable slice).';
    return `CRITIQUE (${mode}) this mind-map. Board=${nodes}\n${lens} Return exactly 1 node with category "insight".`;
  }
  return `GENERATE a mind-map constellation for the goal: "${prompt}".\nReturn exactly 5 nodes: node[0] is the goal (category "goal"), then 4 branches covering strategy, product, growth, risk.`;
}

function extractJson(text: string): unknown {
  const t = (text || '').trim();
  try { return JSON.parse(t); } catch { /* continue */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* continue */ } }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* continue */ } }
  return null;
}

async function tryMeta(apiKey: string, model: string, task: string): Promise<unknown> {
  const res = await fetch(`${META_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 2600,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: task }
      ]
    })
  });
  if (!res.ok) throw new Error(`meta ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return extractJson(data.choices?.[0]?.message?.content || '');
}

async function tryGemini(apiKey: string, task: string): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: task }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.8, maxOutputTokens: 1200 }
    })
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return extractJson(text);
}

async function tryOpenAI(apiKey: string, task: string): Promise<unknown> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.8,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: task }
      ]
    })
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return extractJson(data.choices?.[0]?.message?.content || '{}');
}

function sanitize(parsed: unknown): { spokenReply: string; nodes: unknown[]; connectToIds?: string[] } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p['nodes']) || typeof p['spokenReply'] !== 'string') return null;
  return { spokenReply: p['spokenReply'] as string, nodes: p['nodes'] as unknown[], connectToIds: p['connectToIds'] as string[] | undefined };
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method === 'GET') {
    // Cheap status probe for the HUD badge: which engine is configured.
    // Costs no tokens and never exposes any key.
    const metaKey = process.env['META_API_KEY'] || process.env['MODEL_API_KEY'] || '';
    const geminiKey = process.env['GEMINI_API_KEY'] || '';
    const openaiKey = process.env['OPENAI_API_KEY'] || '';
    const mode = metaKey ? 'meta' : geminiKey ? 'gemini' : openaiKey ? 'openai' : 'local';
    const model =
      metaKey ? (process.env['META_MODEL'] || META_DEFAULT_MODEL)
      : geminiKey ? 'gemini-2.5-flash'
      : openaiKey ? 'gpt-4o-mini' : '';
    res.status(200).json({ mode, model });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const body = req.body || {};
  try {
    const task = taskFor(body);
    const metaKey = process.env['META_API_KEY'] || process.env['MODEL_API_KEY'] || '';
    const metaModel = process.env['META_MODEL'] || META_DEFAULT_MODEL;
    const geminiKey = process.env['GEMINI_API_KEY'] || '';
    const openaiKey = process.env['OPENAI_API_KEY'] || '';

    if (metaKey) {
      try {
        const parsed = await tryMeta(metaKey, metaModel, task);
        const clean = sanitize(parsed);
        if (clean) { res.status(200).json({ ...clean, provider: 'meta' }); return; }
      } catch { /* fall through */ }
    }
    if (geminiKey) {
      try {
        const parsed = await tryGemini(geminiKey, task);
        const clean = sanitize(parsed);
        if (clean) { res.status(200).json({ ...clean, provider: 'gemini' }); return; }
      } catch { /* fall through */ }
    }
    if (openaiKey) {
      try {
        const parsed = await tryOpenAI(openaiKey, task);
        const clean = sanitize(parsed);
        if (clean) { res.status(200).json({ ...clean, provider: 'openai' }); return; }
      } catch { /* fall through */ }
    }
    // No server key configured (or all providers failed): tell the client to use
    // its own Meta key directly, or fall back to the offline engine client-side.
    res.status(200).json({ provider: 'local', spokenReply: '', nodes: [], useClientKey: true });
  } catch {
    res.status(200).json({ provider: 'local', spokenReply: '', nodes: [], useClientKey: true });
  }
}
