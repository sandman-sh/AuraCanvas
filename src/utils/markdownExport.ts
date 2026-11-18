import type { IdeaNodeData } from '../types/graph';

export function buildMarkdown(nodes: IdeaNodeData[], edges: { a: string; b: string }[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  lines.push('# AuraCanvas Action Plan');
  lines.push('');
  lines.push(`_Exported ${new Date().toLocaleString()} — ${nodes.length} nodes, ${edges.length} links_`);
  lines.push('');
  const order: IdeaNodeData[] = [];
  const goal = nodes.find((n) => n.category === 'goal');
  if (goal) order.push(goal);
  for (const n of nodes) if (n !== goal) order.push(n);
  order.forEach((n, i) => {
    const head = n.category === 'goal' ? '##' : '###';
    lines.push(`${head} ${i + 1}. ${n.title} \`[${n.category}]\``);
    lines.push('');
    lines.push(`> ${n.summary}`);
    lines.push('');
    for (const b of n.bullets) lines.push(`- [ ] ${b}`);
    lines.push('');
    const linked = edges
      .filter((e) => e.a === n.id || e.b === n.id)
      .map((e) => byId.get(e.a === n.id ? e.b : e.a)?.title)
      .filter(Boolean);
    if (linked.length) {
      lines.push(`_Linked: ${[...new Set(linked)].join(' · ')}_`);
      lines.push('');
    }
  });
  lines.push('---');
  lines.push('_Made in AuraCanvas — Agentic Spatial Mind-Map Studio_');
  return lines.join('\n');
}

export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}

export async function copyMarkdown(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}
