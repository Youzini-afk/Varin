import { join } from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';

/** Non-model service secrets (search and outbound proxy), owned by this Host.
 * No credential import, model-provider fallback or read-time repair. */
export function createServiceCredentialStore(dataDirectory: string) {
  const store = createSettingsFileStore({ filePath: join(dataDirectory, 'service-auth.json') });
  const validate = (document: Record<string, unknown>): Record<string, unknown> => {
    for (const value of Object.values(document)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value as Record<string, unknown>).type !== 'api_key'
        || typeof (value as Record<string, unknown>).key !== 'string') throw new Error('Service credential store is invalid');
    }
    return document;
  };
  const read = () => validate(store.readSync());
  const save = async (reference: unknown, entry: Record<string, unknown>) => {
    if (typeof reference !== 'string' || !reference.trim() || typeof entry.key !== 'string' || !entry.key.trim()) throw new Error('Service credential reference and key are required');
    return store.transact(document => {
      validate(document);
      document[reference.trim()] = { type: 'api_key', key: entry.key };
      return { document, result: undefined };
    });
  };
  const remove = async (reference: unknown): Promise<boolean> => {
    if (typeof reference !== 'string' || !reference.trim()) throw new Error('Service credential reference is required');
    return store.transact(document => {
      validate(document);
      const existed = Object.hasOwn(document, reference.trim());
      delete document[reference.trim()];
      return { document, result: existed, write: existed };
    });
  };
  return { read, save, remove };
}
export type ServiceCredentialStore = ReturnType<typeof createServiceCredentialStore>;
