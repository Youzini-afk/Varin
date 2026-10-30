export type CatalogThreadRole = { thread_id: string; parent_thread_id: string | null; bot_id: string | null };

/** Ordinary roots and tasks handed over directly by a Bot conversation lead their work.
 * A Bot's own conversation is its session, while nested workers keep their child role. */
export function isLeadThread(thread: CatalogThreadRole, byId: ReadonlyMap<string, CatalogThreadRole>): boolean {
  if (!thread.parent_thread_id) return !thread.bot_id;
  const parent = byId.get(thread.parent_thread_id);
  return !!parent && !!parent.bot_id && parent.bot_id === thread.bot_id && !parent.parent_thread_id;
}
