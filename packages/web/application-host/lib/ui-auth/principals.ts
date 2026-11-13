/** Persistent authentication subjects, separate from rotating sessions and devices.
 * This module does not enroll users or provide a plugin account system. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { resolveVarinDataDir } from '../platform/data-paths.js';

interface Principal { id: string; disabled: boolean }
interface PrincipalDocument extends Record<string, unknown> { version: 1; ownerId: string; principals: Principal[] }
export function createPrincipalStore(filePath = path.join(resolveVarinDataDir(process), 'ui-principals.json')) {
  const id = `usr_${randomUUID()}`;
  const store = createSettingsFileStore({ filePath, defaultValue: {
    version: 1, ownerId: id, principals: [{ id, disabled: false }],
  } });
  function parse(value: unknown): PrincipalDocument {
    const document = value as PrincipalDocument;
    if (!document || document.version !== 1 || typeof document.ownerId !== 'string' || !Array.isArray(document.principals)
      || !document.principals.some(p => p?.id === document.ownerId)
      || document.principals.some(p => !p || typeof p.id !== 'string' || !p.id.trim() || p.id !== p.id.trim() || typeof p.disabled !== 'boolean')
      || new Set(document.principals.map(p => p.id)).size !== document.principals.length) {
      throw Object.assign(new Error('Authentication principal store is malformed'), { statusCode: 503 });
    }
    return document;
  }
  // Initialization is the only writer. Share its promise so concurrent first
  // requests cannot observe an unpersisted or independently generated subject.
  let initialized: Promise<PrincipalDocument> | undefined;
  const document = (): Promise<PrincipalDocument> => initialized ??= store.transact(raw => {
    const value = parse(raw);
    return { document: value, result: value, write: value.ownerId === id };
  });
  return {
    ownerId: async () => (await document()).ownerId,
    resolve: async (id: string) => (await document()).principals.find(p => p.id === id && !p.disabled)?.id ?? null,
    isOwner: async (id: string) => { const value = await document(); return value.ownerId === id && value.principals.some(p => p.id === id && !p.disabled); },
  };
}
export type PrincipalStore = ReturnType<typeof createPrincipalStore>;
let shared: PrincipalStore | undefined;
export const hostPrincipals = (): PrincipalStore => shared ??= createPrincipalStore();
