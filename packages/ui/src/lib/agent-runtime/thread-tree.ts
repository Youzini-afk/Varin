import type { ThreadSummary } from '@varin/protocol';

export interface ThreadTreeNode { thread: ThreadSummary; children: ThreadTreeNode[] }
export const sortThreads = (threads: readonly ThreadSummary[]) => [...threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at_ms - a.updated_at_ms || a.thread_id.localeCompare(b.thread_id));

export function threadSubtreeIds(threads: readonly ThreadSummary[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const thread of threads) if (thread.parent_thread_id) {
    const siblings = children.get(thread.parent_thread_id) ?? [];
    siblings.push(thread.thread_id); children.set(thread.parent_thread_id, siblings);
  }
  const ids = [rootId];
  for (let index = 0; index < ids.length; index++) ids.push(...children.get(ids[index]!) ?? []);
  return ids;
}

/** Parent relationships come from the Catalog. An archived/deleted parent does not
 * hide a visible child, and search keeps the ancestors of matching children. */
export function buildThreadTree(threads: readonly ThreadSummary[], matches: (thread: ThreadSummary) => boolean): ThreadTreeNode[] {
  const nodes = new Map(sortThreads(threads).map(thread => [thread.thread_id, { thread, children: [] as ThreadTreeNode[] }]));
  const roots: ThreadTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parent_thread_id ? nodes.get(node.thread.parent_thread_id) : undefined;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const filter = (node: ThreadTreeNode): ThreadTreeNode | null => {
    if (matches(node.thread)) return node;
    const children = node.children.flatMap(child => { const match = filter(child); return match ? [match] : []; });
    return children.length ? { ...node, children } : null;
  };
  return roots.flatMap(node => { const match = filter(node); return match ? [match] : []; });
}
