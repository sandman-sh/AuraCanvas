/** Shared data models for AuraCanvas spatial mind-map graph. */

export type NodeCategory =
  | 'goal'
  | 'strategy'
  | 'product'
  | 'growth'
  | 'risk'
  | 'synthesis'
  | 'insight'
  | 'tutorial';

export interface IdeaNodeData {
  id: string;
  title: string;
  summary: string;
  bullets: string[];
  category: NodeCategory;
  /** Last saved spatial position (world units). Restored on reopen. */
  pos?: [number, number, number];
}

export interface AgentActionResponse {
  spokenReply: string;
  nodes: IdeaNodeData[];
  connectToIds?: string[];
}

export type AgentAction = 'generate' | 'merge' | 'expand' | 'critique';

/** Structured review lenses cycled by the Review action. */
export type CritiqueMode = 'blindspot' | 'premortem' | 'fivewhys';

export interface AgentRequest {
  action: AgentAction;
  prompt: string;
  existingNodes?: IdeaNodeData[];
  focusNode?: IdeaNodeData;
  mergePair?: [IdeaNodeData, IdeaNodeData];
  mode?: CritiqueMode;
}

export type AuraState = 'idle' | 'listening' | 'thinking' | 'speaking';

export const CATEGORY_COLORS: Record<NodeCategory, number> = {
  goal: 0x0071e3,
  strategy: 0x0a84ff,
  product: 0x5e5ce6,
  growth: 0x1d8127,
  risk: 0xb56a00,
  synthesis: 0x7d3ff2,
  insight: 0xc2274d,
  tutorial: 0x0071e3
};

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  goal: 'GOAL',
  strategy: 'STRATEGY',
  product: 'PRODUCT',
  growth: 'GROWTH',
  risk: 'RISK',
  synthesis: 'SYNTHESIS',
  insight: 'INSIGHT',
  tutorial: 'START'
};

export function uid(prefix = 'n'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}
