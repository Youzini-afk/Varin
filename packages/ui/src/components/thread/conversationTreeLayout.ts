import type { ThreadConversationTree, ThreadConversationTreeNode } from '@varin/application-client';

export type ConversationTreeRow =
  | { kind: 'node'; node: ThreadConversationTreeNode; depth: number }
  | { kind: 'gap'; id: string; nodes: ThreadConversationTreeNode[]; depth: number; expanded: boolean };

/** Compress only linear stretches. Splits, endpoints and selected turns stay visible. */
export function conversationTreeRows(tree: ThreadConversationTree, expanded: Record<string, boolean>, selected?: string): ConversationTreeRow[] {
  const children = new Map<string | null, ThreadConversationTreeNode[]>();
  for (const node of tree.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node); children.set(node.parentId, siblings);
  }
  const endpoints = new Set(tree.routes.map(route => route.nodeId));
  const rows: ConversationTreeRow[] = [];
  const pending = (children.get(null) ?? []).slice().reverse().map(node => ({ node, depth: 0 }));
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    const chain = [node];
    let next = children.get(node.id) ?? [];
    while (next.length === 1 && !endpoints.has(chain.at(-1)!.id)) {
      chain.push(next[0]!); next = children.get(next[0]!.id) ?? [];
    }
    const middle = chain.slice(2, -2);
    const gapId = `gap:${chain[0]!.id}`;
    if (chain.length > 6) {
      for (const item of chain.slice(0, 2)) rows.push({ kind: 'node', node: item, depth });
      rows.push({ kind: 'gap', id: gapId, nodes: middle, depth, expanded: expanded[gapId] ?? middle.some(item => item.id === selected) });
      for (const item of chain.slice(-2)) rows.push({ kind: 'node', node: item, depth });
    } else for (const item of chain) rows.push({ kind: 'node', node: item, depth });
    for (const [index, child] of next.slice().reverse().entries()) {
      pending.push({ node: child, depth: depth + (next.length > 1 && index < next.length - 1 ? 1 : 0) });
    }
  }
  return rows;
}

export function conversationTreePath(tree: ThreadConversationTree, branchId: string): Set<string> {
  const nodes = new Map(tree.nodes.map(node => [node.id, node]));
  const path = new Set<string>();
  let id = tree.routes.find(route => route.branchId === branchId)?.nodeId;
  while (id && !path.has(id)) { path.add(id); id = nodes.get(id)?.parentId; }
  return path;
}
