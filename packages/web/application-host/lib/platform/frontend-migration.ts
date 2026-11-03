import { createHash, randomUUID } from 'node:crypto';
import { exportDesktopFrontendEntries, validateDesktopFrontendStage, type DesktopFrontendStage, type DesktopFrontendImportReceipt } from '@varin/application-client/desktop';
interface SettingsOwner {
  readSync(): Record<string, unknown>;
  update(mutator: (root: Record<string, unknown>) => void): Promise<unknown>;
}
const key = 'desktopFrontendMigration';
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The original cross-process settings transaction owns both staging and receipt.
 * No profile files, cookies, secrets or concurrent browser databases are opened. */
export function createDesktopFrontendMigrationOwner(store: SettingsOwner) {
  return {
    async stage(entries: readonly (readonly [
      string,
      string
    ])[], sourceVersion: string) {
      const payload = exportDesktopFrontendEntries(entries), digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const value: DesktopFrontendStage = { schema: 1, id: randomUUID(), digest, sourceOrigin: 'varin-ui://app', sourceVersion, stage: 'staged', payload };
      let result: unknown;
      await store.update(root => {
        const existing = object(root[key]); if (existing?.schema === 1 && existing.stage === 'imported') {
          result = existing;
          return;
        } if (existing?.schema === 1 && existing.stage === 'staged') {
          result = existing;
          return;
        } root[key] = value; result = value;
      });
      const staged = object(result)!;
      const retained = object(staged.payload);
      return { schema: 1, id: staged.id, digest: staged.digest, stage: staged.stage, entryCount: retained?.entries ? Object.keys(retained.entries as object).length : 0, pendingDrafts: retained?.pendingDrafts ?? staged.pendingDrafts ?? 0, credentialSlots: retained?.credentialSlots ?? staged.credentialSlots ?? [] };
    },
    read(): DesktopFrontendStage | null {
      const value = object(store.readSync()[key]); if (!value || value.stage === 'imported')
        return null; return validateDesktopFrontendStage(value);
    },
    async complete(input: unknown) {
      const receipt = object(input);
      if (!receipt || typeof receipt.id !== 'string' || typeof receipt.digest !== 'string' || !Array.isArray(receipt.importedKeys) || !Array.isArray(receipt.retainedKeys) || ![...receipt.importedKeys, ...receipt.retainedKeys].every(value => typeof value === 'string'))
        throw new Error('Invalid frontend import receipt');
      await store.update(root => {
        const existing = object(root[key]);
        if (existing?.stage === 'imported' && existing.id === receipt.id && existing.digest === receipt.digest)
          return;
        const staged = validateDesktopFrontendStage(existing);
        if (staged.id !== receipt.id || staged.digest !== receipt.digest)
          throw new Error('Frontend export changed; retry from its current receipt');
        const reported = [...receipt.importedKeys as string[], ...receipt.retainedKeys as string[]];
        const expected = Object.keys(staged.payload.entries);
        if (new Set(reported).size !== reported.length || reported.length !== expected.length || reported.some(key => !Object.hasOwn(staged.payload.entries, key)))
          throw new Error('Frontend import did not account for every exported entry');
        // Remove the temporary copy only after the target verified every local write.
        root[key] = { schema: 1, stage: 'imported', id: staged.id, digest: staged.digest, sourceOrigin: staged.sourceOrigin, sourceVersion: staged.sourceVersion, completedAt: new Date().toISOString(), importedKeys: receipt.importedKeys, retainedKeys: receipt.retainedKeys, pendingDrafts: staged.payload.pendingDrafts, credentialSlots: staged.payload.credentialSlots, credentialsComplete: staged.payload.credentialSlots.length === 0 || object(root.desktopNativeMigration)?.credentialsComplete === true, indexedDb: staged.payload.indexedDb };
      });
      return null;
    },
  };
}
export type { DesktopFrontendImportReceipt };
