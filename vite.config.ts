import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read KEY=VALUE pairs from a .env file into process.env WITHOUT overriding
 * real environment variables and WITHOUT ever printing values. Vite only
 * auto-loads VITE_* keys for the browser; the server-side agent route needs
 * the raw keys, so this makes `./.env` (and the parent `../.env`, as a
 * convenience) available to the dev agent plugin deterministically.
 */
function loadServerEnv(): void {
  const files = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '..', '.env')
  ];
  for (const file of files) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
}

loadServerEnv();

/** Key names + lengths only — safe to print, never values. */
function keyReport(): string {
  const parts: string[] = [];
  for (const k of ['META_API_KEY', 'MODEL_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'META_MODEL']) {
    const v = process.env[k] || '';
    parts.push(`${k}=${v ? v.length + 'ch' : '—'}`);
  }
  return parts.join(' ');
}

const SYSTEM = `You are Aura, a spatial mind-map agent for a Meta Quest mixed-reality app.
Always reply with strict JSON only, no prose outside JSON:
{"spokenReply": string (<=18 words), "nodes": [{"id": string, "title": string (<=5 words), "summary": string (<=14 words), "bullets": string[2-3 each <=8 words], "category": "goal|strategy|product|growth|risk|synthesis|insight"}], "connectToIds"?: string[]}
Categories: goal=central aim, strategy=plan of action, product=feature or artefact, growth=traction channel, risk=danger or blocker, synthesis=golden merged plan, insight=missing-angle critique.`;

function taskFor(body: any): string {
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

function sanitize(parsed: unknown): { spokenReply: string; nodes: unknown[]; connectToIds?: string[] } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p['nodes']) || typeof p['spokenReply'] !== 'string') return null;
  return { spokenReply: p['spokenReply'] as string, nodes: p['nodes'] as unknown[], connectToIds: p['connectToIds'] as string[] | undefined };
}

async function tryMeta(apiKey: string, model: string, task: string): Promise<unknown> {
  const res = await fetch('https://api.meta.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, response_format: { type: 'json_object' }, temperature: 0.7, max_tokens: 2600,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }]
    })
  });
  if (!res.ok) throw new Error(`meta ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return extractJson(data.choices?.[0]?.message?.content || '');
}

async function tryGemini(apiKey: string, task: string): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: task }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.8, maxOutputTokens: 1200 }
    })
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return extractJson(data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '');
}

async function tryOpenAI(apiKey: string, task: string): Promise<unknown> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', response_format: { type: 'json_object' }, temperature: 0.8,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }]
    })
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return extractJson(data.choices?.[0]?.message?.content || '{}');
}

/** Local `npm run dev` serves the same /api/agent providers as production,
 *  using server-side keys from .env (META_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY). */
function devAgentPlugin(): Plugin {
  return {
    name: 'auracanvas-dev-agent',
    configureServer(server) {
      console.log(`[auracanvas-dev-agent] server keys: ${keyReport()}`);
      server.middlewares.use('/api/agent', (req, res) => {
        if (req.method === 'GET') {
          // Cheap status probe for the HUD badge: which engine is configured.
          const metaKey = process.env['META_API_KEY'] || process.env['MODEL_API_KEY'] || '';
          const metaModel = process.env['META_MODEL'] || 'muse-spark-1.3';
          const geminiKey = process.env['GEMINI_API_KEY'] || '';
          const openaiKey = process.env['OPENAI_API_KEY'] || '';
          const mode = metaKey ? 'meta' : geminiKey ? 'gemini' : openaiKey ? 'openai' : 'local';
          const model = metaKey ? metaModel : geminiKey ? 'gemini-2.5-flash' : openaiKey ? 'gpt-4o-mini' : '';
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ mode, model }));
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
          try {
            const body = raw ? JSON.parse(raw) : {};
            const task = taskFor(body);
            const metaKey = process.env['META_API_KEY'] || process.env['MODEL_API_KEY'] || '';
            const metaModel = process.env['META_MODEL'] || 'muse-spark-1.3';
            const geminiKey = process.env['GEMINI_API_KEY'] || '';
            const openaiKey = process.env['OPENAI_API_KEY'] || '';
            if (metaKey) {
              try {
                const clean = sanitize(await tryMeta(metaKey, metaModel, task));
                if (clean) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...clean, provider: 'meta' })); return; }
                console.log('[auracanvas-dev-agent] meta returned unusable JSON — trying next provider');
              } catch (e) { console.log(`[auracanvas-dev-agent] meta failed: ${e instanceof Error ? e.message : e}`); }
            }
            if (geminiKey) {
              try {
                const clean = sanitize(await tryGemini(geminiKey, task));
                if (clean) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...clean, provider: 'gemini' })); return; }
                console.log('[auracanvas-dev-agent] gemini returned unusable JSON — trying next provider');
              } catch (e) { console.log(`[auracanvas-dev-agent] gemini failed: ${e instanceof Error ? e.message : e}`); }
            }
            if (openaiKey) {
              try {
                const clean = sanitize(await tryOpenAI(openaiKey, task));
                if (clean) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...clean, provider: 'openai' })); return; }
                console.log('[auracanvas-dev-agent] openai returned unusable JSON — trying next provider');
              } catch (e) { console.log(`[auracanvas-dev-agent] openai failed: ${e instanceof Error ? e.message : e}`); }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ provider: 'local', spokenReply: '', nodes: [], useClientKey: true }));
          } catch {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ provider: 'local', spokenReply: '', nodes: [], useClientKey: true }));
          }
        });
      });
    }
  };
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200
  },
  server: {
    port: 5173,
    host: true
  },
  plugins: [devAgentPlugin()]
});
