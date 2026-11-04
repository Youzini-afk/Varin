import { FRONTEND_MIGRATION_MARKER_KEY, validateDesktopFrontendStage, type DesktopFrontendImportReceipt } from '@varin/application-client/desktop';
import type { DesktopNativeTransport } from './bridge.js';
/** Runs before any React/Zustand module hydrates. A new shell never overwrites a
 * preference already authored in its own origin, including on partial retries. */
export async function importDesktopFrontendState(storage: Storage, transport: DesktopNativeTransport, subtle: SubtleCrypto): Promise<DesktopFrontendImportReceipt | null> {
  const raw = await transport.invoke<string | null>('varin_frontend_migration', { action: 'read' });
  if (raw === null)
    return null;
  const stage = validateDesktopFrontendStage(JSON.parse(raw));
  const bytes = new TextEncoder().encode(JSON.stringify(stage.payload));
  const digest = [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
  if (digest !== stage.digest)
    throw new Error('Desktop frontend export integrity check failed');
  const importedKeys: string[] = [], retainedKeys: string[] = [];
  for (const [key, value] of Object.entries(stage.payload.entries)) {
    const previous = storage.getItem(key);
    if (previous !== null) {
      retainedKeys.push(key);
      continue;
    }
    storage.setItem(key, value);
    if (storage.getItem(key) !== value)
      throw new Error('Desktop preference write was not retained');
    importedKeys.push(key);
  }
  const receipt = { id: stage.id, digest, importedKeys, retainedKeys };
  const marker = JSON.stringify({ schema: 1, ...receipt, pendingDrafts: stage.payload.pendingDrafts, credentialSlots: stage.payload.credentialSlots });
  storage.setItem(FRONTEND_MIGRATION_MARKER_KEY, marker);
  if (storage.getItem(FRONTEND_MIGRATION_MARKER_KEY) !== marker)
    throw new Error('Desktop migration marker was not retained');
  await transport.invoke('varin_frontend_migration', { action: 'complete', ...receipt });
  return receipt;
}
