/** Share unchanged JSON subtrees, including entities that move within ordered collections. */
export function shareSnapshot<T>(previous: T | undefined, next: T): T {
  if (previous === next) return next;
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    const key = (item: unknown): unknown => item && typeof item === 'object'
      ? ('id' in item ? item.id : 'execution_id' in item ? item.execution_id : 'operation_id' in item ? item.operation_id
        : 'branch_id' in item ? item.branch_id : 'thread_id' in item ? item.thread_id : 'child_thread_id' in item ? item.child_thread_id : undefined) : undefined;
    const indexed = new Map<unknown, unknown>(previous.flatMap(item => { const id = key(item); return id === undefined ? [] : [[id, item]]; }));
    const result = next.map((item, index) => shareSnapshot(indexed.get(key(item)) ?? previous[index], item));
    return (previous.length === result.length && result.every((item, index) => item === previous[index]) ? previous : result) as T;
  }
  if (Array.isArray(previous)) return next;
  const old = previous as Record<string, unknown>, value = next as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let unchanged = Object.keys(old).length === Object.keys(value).length;
  for (const key of Object.keys(value)) {
    result[key] = shareSnapshot(old[key], value[key]);
    unchanged &&= result[key] === old[key] && key in old;
  }
  return (unchanged ? previous : result) as T;
}
