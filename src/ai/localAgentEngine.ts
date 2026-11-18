import type { AgentActionResponse, CritiqueMode, IdeaNodeData, NodeCategory } from '../types/graph';
import { uid } from '../types/graph';

export interface Preset {
  name: string;
  prompt: string;
  goal: IdeaNodeData;
  branches: IdeaNodeData[];
  spokenReply: string;
}

function n(title: string, summary: string, bullets: string[], category: NodeCategory): IdeaNodeData {
  return { id: uid('n'), title, summary, bullets, category };
}

export const PRESETS: Preset[] = [
  {
    name: 'AI Startup Launch',
    prompt: 'Launch an AI productivity app',
    spokenReply: 'Startup constellation ready. Five lanes from MVP to your first hundred users.',
    goal: { id: 'preset_goal_1', title: 'AI Startup Launch', summary: 'Ship a focused AI MVP in 6 weeks', bullets: ['Define one painful workflow', 'Ship weekly to 10 testers', 'Charge from day one'], category: 'goal' },
    branches: [
      { id: uid('n'), title: 'MVP Scope', summary: 'One workflow, done brilliantly', bullets: ['Cut scope to 1 job-to-be-done', 'Prototype in 7 days', 'Instrument activation event'], category: 'strategy' },
      { id: uid('n'), title: 'Viral Launch Loop', summary: 'Every user brings one more', bullets: ['Shareable output artifact', 'Waitlist with referral boost', 'Launch on 3 communities'], category: 'growth' },
      { id: uid('n'), title: 'Pricing Model', summary: 'Seat plus usage, free trial', bullets: ['$19 starter seat', 'Usage cap with overage', 'Annual discount 20%'], category: 'product' },
      { id: uid('n'), title: 'First 100 Users', summary: 'Hand-recruit design partners', bullets: ['List 100 dream users', '30 discovery calls', '10 paid pilots'], category: 'growth' },
      { id: uid('n'), title: 'Retention Risk', summary: 'Watch week-2 drop-off', bullets: ['Onboarding under 3 minutes', 'Weekly value email', 'Churn interview script'], category: 'risk' }
    ]
  },
  {
    name: 'Indie VR Game Design',
    prompt: 'Design an indie VR game',
    spokenReply: 'Game design constellation live. Core loop, comfort, and your social hook mapped.',
    goal: { id: 'preset_goal_2', title: 'Indie VR Game', summary: 'A cozy hands-first VR toy', bullets: ['One 5-min core loop', 'Comfort-first movement', 'Playtest every Friday'], category: 'goal' },
    branches: [
      { id: uid('n'), title: 'Hands-First Core Loop', summary: 'Grab, smash, synthesize', bullets: ['Pinch-grab anything', 'Merge to craft items', 'Haptic chime feedback'], category: 'product' },
      { id: uid('n'), title: 'Comfort and 60FPS', summary: 'No motion sickness ever', bullets: ['Teleport + vignette', 'Lock to 72fps budget', 'Seated mode default'], category: 'strategy' },
      { id: uid('n'), title: 'Cozy Art Style', summary: 'Low-poly glow diorama', bullets: ['3-color palette', 'Baked soft shadows', 'One hero creature'], category: 'product' },
      { id: uid('n'), title: 'Social Hook', summary: 'Ghosts of friends build', bullets: ['Async ghost builders', 'Weekly build prompt', 'Clip share button'], category: 'growth' },
      { id: uid('n'), title: 'Playtest Funnel', summary: 'Ten strangers weekly', bullets: ['Discord test nights', '3-question survey', 'Fix top crash first'], category: 'risk' }
    ]
  },
  {
    name: 'Tokyo Trip Plan',
    prompt: 'Plan a 5-day Tokyo architecture and food trip',
    spokenReply: 'Tokyo board is set. Wards, day trips, ramen, rail pass, and packing covered.',
    goal: { id: 'preset_goal_3', title: 'Tokyo Trip 5 Days', summary: 'Architecture walks plus food crawl', bullets: ['Book flights + hotel', 'Buy rail pass early', 'Reserve 2 dinners'], category: 'goal' },
    branches: [
      { id: uid('n'), title: 'Shibuya Harajuku', summary: 'Day 1-2 design walk', bullets: ['Meiji shrine morning', 'Cat Street studios', 'Shibuya Sky sunset'], category: 'strategy' },
      { id: uid('n'), title: 'Kyoto Bullet Train', summary: 'Day 3 temples sprint', bullets: ['7am Nozomi train', 'Kengo Kuma museum', 'Return by 9pm'], category: 'growth' },
      { id: uid('n'), title: 'Hidden Ramen Spots', summary: 'Five bowls, no queues', bullets: ['Fuunji Shinjuku', 'Kagari Ginza', 'Order via ticket machine'], category: 'product' },
      { id: uid('n'), title: 'Budget Rail Pass', summary: 'Cap spend at $1400', bullets: ['7-day JR pass math', 'Suica for metro', 'Conbini breakfasts'], category: 'risk' },
      { id: uid('n'), title: 'Packing List', summary: 'Carry-on only, walk far', bullets: ['Broken-in sneakers', 'Coin purse + eSIM', 'Foldable tote bag'], category: 'product' }
    ]
  }
];

function cleanTopic(prompt: string): string {
  const p = prompt.trim().replace(/^(please\s+)?(plan|build|create|make|design|launch|help me |i want to )/i, '').trim();
  const words = p.split(/\s+/).filter(Boolean).slice(0, 5);
  const t = words.join(' ');
  return t.length > 2 ? titleCase(t) : 'New Venture';
}

const STOP = new Set([
  'with', 'from', 'into', 'that', 'this', 'your', 'about', 'plan', 'build',
  'create', 'make', 'design', 'launch', 'help', 'want', 'need', 'idea',
  'project', 'please', 'goal', 'board', 'list', 'organize', 'think', 'ideas',
  'what', 'when', 'where', 'with', 'and', 'the', 'for', 'are', 'how'
]);

/** Content words from free text, in order, deduplicated. Drives offline relevance. */
export function keywordsOf(text: string, max = 6): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)) {
    const c = w.trim();
    if (c.length < 3 || STOP.has(c) || out.includes(c)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function shortVerb(topic: string): string {
  const t = topic.toLowerCase();
  if (t.includes('app') || t.includes('saas') || t.includes('startup')) return 'Ship';
  if (t.includes('study') || t.includes('learn') || t.includes('exam') || t.includes('machine learning')) return 'Master';
  if (t.includes('trip') || t.includes('travel') || t.includes('tokyo')) return 'Route';
  if (t.includes('game')) return 'Prototype';
  if (t.includes('fit') || t.includes('health') || t.includes('workout')) return 'Train';
  if (t.includes('book') || t.includes('novel') || t.includes('write')) return 'Draft';
  return 'Launch';
}

export function localGenerate(prompt: string): AgentActionResponse {
  const clean = prompt.trim();
  const lower = clean.toLowerCase();
  const presetHit = PRESETS.find(
    (p) =>
      lower.includes(p.prompt.toLowerCase().slice(0, 12)) ||
      p.name.toLowerCase().split(' ')[0] === lower.split(' ')[0]
  );
  const keywordHit =
    PRESETS.find((p) => {
      const keys: Record<string, string[]> = {
        'AI Startup Launch': ['startup', 'saas', 'productivity app', 'mvp', 'ai app'],
        'Indie VR Game Design': ['vr game', 'indie game', 'game design', 'unity', 'unreal'],
        'Tokyo Trip Plan': ['tokyo', 'japan', 'kyoto', 'trip', 'travel', 'vacation']
      };
      return (keys[p.name] || []).some((k) => lower.includes(k));
    }) || presetHit;
  if (keywordHit) {
    const goal = { ...keywordHit.goal, id: uid('goal') };
    const branches = keywordHit.branches.map((b) => ({ ...b, id: uid('n') }));
    return { spokenReply: keywordHit.spokenReply, nodes: [goal, ...branches] };
  }
  const topic = cleanTopic(clean);
  const verb = shortVerb(topic);
  const topicFor = topic.replace(/^(a|an|the)\s+/i, '');
  const keys = keywordsOf(clean, 6);
  const k = (i: number, fb: string): string => cap(keys[i] || fb);
  const short = topic.slice(0, 20);
  const isStudy = /study|learn|exam|course|machine learning|react|fitness/.test(lower);
  const goal: IdeaNodeData = {
    id: uid('goal'),
    title: topic.slice(0, 26),
    summary: `${verb} ${topicFor.toLowerCase().slice(0, 30)} in focused sprints`,
    bullets: [`Define done for ${short}`, `First ${keys[0] || 'step'} win this week`, 'Review and iterate Friday'],
    category: 'goal'
  };
  const branches: IdeaNodeData[] = [
    {
      id: uid('n'), title: isStudy ? `${k(0, 'Study')} Roadmap` : `${k(0, 'Strategy')} Plan`,
      summary: `Phased path through ${short.slice(0, 18)}`,
      bullets: [`Week 1: ${keys[0] || 'foundations'} basics`, `Week 2: guided ${keys[1] || 'practice'} reps`, `Week 3: solo ${short.slice(0, 12)} build`], category: 'strategy'
    },
    {
      id: uid('n'), title: isStudy ? `${k(1, 'Core')} Concepts` : `${k(1, 'Key')} Feature Set`,
      summary: `Three pillars of ${short.slice(0, 18)}`,
      bullets: [`Top ${keys[0] || 'core'} workflows first`, `One ${keys[1] || 'demo'} demo daily`, `Teach ${keys[2] || 'it'} back aloud`], category: 'product'
    },
    {
      id: uid('n'), title: isStudy ? `${k(2, 'Practice')} Reps` : `${k(2, 'Launch')} Momentum`,
      summary: 'Daily reps beat binges',
      bullets: ['25-min focus blocks', `Track ${keys[0] || 'progress'} streaks`, 'Weekly review Friday'], category: 'growth'
    },
    {
      id: uid('n'), title: `${k(3, 'Biggest')} Risk`,
      summary: `What kills ${short.slice(0, 16)} if ignored?`,
      bullets: [`${cap(keys[3] || 'Scope')} guardrail first`, 'Time-box each task', 'Ask for help early'], category: 'risk'
    }
  ];
  return {
    spokenReply: `${topic} mapped. Four lanes around your goal: plan, build, momentum, and risk.`,
    nodes: [goal, ...branches]
  };
}

export function localMerge(a: IdeaNodeData, b: IdeaNodeData): AgentActionResponse {
  const ka = keywordsOf(`${a.title} ${a.summary}`, 2);
  const kb = keywordsOf(`${b.title} ${b.summary}`, 2);
  const wa = cap(ka[0] || a.title.split(/\s+/)[0] || 'Alpha');
  const wb = cap(kb[0] || b.title.split(/\s+/)[0] || 'Beta');
  const combo = `${wa} x ${wb}`.slice(0, 30);
  const actA = (ka[1] || a.bullets[0] || a.summary).slice(0, 34);
  const actB = (kb[1] || b.bullets[0] || b.summary).slice(0, 34);
  const node: IdeaNodeData = {
    id: uid('syn'),
    title: combo,
    summary: `Ship ${wa.toLowerCase()} through ${wb.toLowerCase()} this week`,
    bullets: [
      `Prototype ${actA.slice(0, 22)} inside ${wb.slice(0, 14)}`,
      `Test with 5 ${actB.slice(0, 18)} users`,
      'Ship smallest lovable slice Friday'
    ],
    category: 'synthesis'
  };
  // Special-case the famous demo pair for a delightful canned result
  if (/indie dev/i.test(a.title) && /video/i.test(b.title)) {
    node.title = '60s Live-Build Quest Clips';
    node.summary = 'Weekly build clips grow devlog fans';
    node.bullets = ['Record one 60s build clip', 'Post with #BuildInPublic', 'Pin best clip to store page'];
  } else if (/video/i.test(a.title) && /indie dev/i.test(b.title)) {
    node.title = '60s Live-Build Quest Clips';
    node.summary = 'Weekly build clips grow devlog fans';
    node.bullets = ['Record one 60s build clip', 'Post with #BuildInPublic', 'Pin best clip to store page'];
  }
  return {
    spokenReply: `Synthesized ${a.title} with ${b.title}. New action plan orb ready.`,
    nodes: [node],
    connectToIds: [a.id, b.id]
  };
}

export function localExpand(node: IdeaNodeData): AgentActionResponse {
  const t = node.title;
  const keys = keywordsOf(`${node.title} ${node.summary} ${node.bullets.join(' ')}`, 4);
  const k0 = cap(keys[0] || t.split(/\s+/)[0] || 'Step');
  const k1 = cap(keys[1] || 'Measure');
  const k2 = cap(keys[2] || 'Scale');
  const kids: IdeaNodeData[] = [
    { id: uid('n'), title: `${k0.slice(0, 14)} First Move`, summary: `Smallest win on ${t.slice(0, 16)}`, bullets: [`Do ${k0.toLowerCase().slice(0, 20)} in 25 minutes`, 'Demo to one person today'], category: node.category === 'goal' ? 'strategy' : node.category },
    { id: uid('n'), title: `${k1.slice(0, 14)} Checkpoint`, summary: `Measure and tighten the loop`, bullets: [`Define one ${k1.toLowerCase().slice(0, 16)} metric`, 'Review with a peer Friday'], category: node.category === 'goal' ? 'product' : node.category },
    { id: uid('n'), title: `${k2.slice(0, 14)} Follow-Through`, summary: `Scale what works, cut rest`, bullets: [`Double down on ${k2.toLowerCase().slice(0, 16)} signal`, 'Kill the weakest part'], category: node.category === 'goal' ? 'growth' : node.category }
  ];
  return {
    spokenReply: `Expanded ${t} into three concrete sub-tasks.`,
    nodes: kids,
    connectToIds: [node.id]
  };
}

export function localCritique(existing: IdeaNodeData[], mode: CritiqueMode = 'blindspot'): AgentActionResponse {
  const goal = existing.find((e) => e.category === 'goal');
  const short = (goal?.title || existing[0]?.title || 'the plan').slice(0, 22);
  const keys = keywordsOf(existing.map((e) => `${e.title} ${e.summary}`).join(' '), 3);
  const k0 = cap(keys[0] || 'progress');
  if (mode === 'premortem') {
    const node: IdeaNodeData = {
      id: uid('ins'), title: 'Premortem Flop', summary: `Assume ${short} failed — the cause`,
      bullets: ['Write the failure headline', `Name the weakest ${k0.toLowerCase()} link`, 'Add one guardrail this week'], category: 'insight'
    };
    return { spokenReply: `Premortem done: the likeliest cause of failure is mapped.`, nodes: [node] };
  }
  if (mode === 'fivewhys') {
    const node: IdeaNodeData = {
      id: uid('ins'), title: 'Root Cause Drill', summary: `Ask why until ${short} is obvious`,
      bullets: [`Why is ${k0.toLowerCase()} stuck?`, 'Why does that cause hold?', 'Fix the deepest why first'], category: 'insight'
    };
    return { spokenReply: `Five whys drilled to the root cause. New orb spawned.`, nodes: [node] };
  }
  const cats = new Set(existing.map((e) => e.category));
  let node: IdeaNodeData;
  if (!cats.has('risk')) {
    node = { id: uid('ins'), title: 'Unpriced Risk', summary: 'What kills this if ignored?', bullets: ['List top 3 failure modes', 'Add one guardrail each', 'Schedule pre-mortem Friday'], category: 'insight' };
  } else if (!cats.has('growth')) {
    node = { id: uid('ins'), title: 'Distribution Gap', summary: 'Great product, zero channel', bullets: ['Pick one channel only', 'Post daily for 14 days', 'Track signup source'], category: 'insight' };
  } else if (!cats.has('synthesis')) {
    node = { id: uid('ins'), title: 'Missing First Slice', summary: 'Merge two ideas to ship', bullets: ['Smash two orbs together', 'Scope to one weekend', 'Demo to five users'], category: 'insight' };
  } else if (!cats.has('product')) {
    node = { id: uid('ins'), title: 'Vague Offer', summary: 'Tighten the core promise', bullets: ['One-sentence pitch', 'Name the buyer', 'Price it today'], category: 'insight' };
  } else {
    node = { id: uid('ins'), title: 'Cold-Start Blind Spot', summary: 'Who are the first ten?', bullets: ['Name ten real humans', 'Message three today', 'Book one call'], category: 'insight' };
  }
  return {
    spokenReply: `Blind-spot scan found a gap: ${node.title}. Insight orb spawned.`,
    nodes: [node]
  };
}
