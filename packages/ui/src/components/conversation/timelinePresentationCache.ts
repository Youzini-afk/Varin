const sessions = new Map<string, Map<string, unknown>>();

/** Disposable in-memory view choices. No history bodies or command authority. */
export function timelinePresentationCache<T>(session: string, kind: string, create: () => T): T {
  let values = sessions.get(session);
  if (!values) { values = new Map(); sessions.set(session, values); }
  if (!values.has(kind)) values.set(kind, create());
  return values.get(kind) as T;
}
