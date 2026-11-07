/** A retry keeps the original complete key, including its migration admission generation. */
export function retainCalendarRunKey(keys: Map<string, string>, identity: string, prefix: string | undefined, allocate: () => string): string {
  const existing = keys.get(identity);
  if (existing !== undefined) return existing;
  const key = `${prefix ?? ''}${allocate()}`;
  keys.set(identity, key);
  return key;
}
