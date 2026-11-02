/** Surface owners advertise only the consistency they can actually enforce.
 * Synchronous UI stores compare and mutate in one event-loop turn. Desktop
 * IPC owners remain last-write-wins until their actual writer supports CAS. */
export interface ClientSettingSnapshot {
  values: Record<string, unknown>;
  revision?: string;
  consistency: 'compare-and-swap' | 'last-write-wins';
}
export interface ClientSettingAuthority {
  read(): Promise<Record<string, unknown>>;
  apply(values: Record<string, unknown>): Promise<void>;
  snapshot?(): ClientSettingSnapshot;
  compareAndApply?(values: Record<string, unknown>, expectedRevision?: string): ClientSettingSnapshot;
}
export class ClientSettingConflict extends Error {}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function synchronousClientSetting(
  read: () => Record<string, unknown>,
  apply: (values: Record<string, unknown>) => void,
): ClientSettingAuthority {
  let previous: string | undefined;
  let revision: string;
  const snapshot = (): ClientSettingSnapshot => {
    const values = read();
    const current = canonical(values);
    if (previous !== current) { previous = current; revision = crypto.randomUUID(); }
    return { values, revision, consistency: 'compare-and-swap' };
  };
  return {
    read: async () => read(), apply: async values => apply(values), snapshot,
    compareAndApply(values, expectedRevision) {
      const before = snapshot();
      if (expectedRevision !== undefined && expectedRevision !== before.revision) throw new ClientSettingConflict('revision conflict — re-read this Surface setting');
      // No await between comparison and this store's writer.
      apply(values);
      return snapshot();
    },
  };
}

export async function clientSettingSnapshot(authority: ClientSettingAuthority): Promise<ClientSettingSnapshot> {
  return authority.snapshot?.() ?? { values: await authority.read(), consistency: 'last-write-wins' };
}
