import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BotSummary } from '@varin/application-client';
import { botScopeId, threadScopeId, knowledgeStoreKeyForScope, scopeOfScopeId } from '../harness/owner-scope.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { knowledgeVectorScopeKey } from '../knowledge/vectors/store.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';

/** Called only after durable Bot admission is closed and its sleep operation completed. */
export function createBotDataCleanup(options: {
  dataDir: string;
  hostId: string;
  deleteAgentScope(bot: BotSummary): Promise<void>;
  closeMemory(scopeId: string, storeKey: string): Promise<void>;
  releaseRemoteScope(scopeId: string): Promise<void>;
  files: Pick<KernelFileResourceBackend, 'remove'>;
}) {
  return async (bot: BotSummary): Promise<void> => {
    if (!bot.deletion || bot.activity?.state !== 'asleep') throw new Error('Bot must finish stopping before deletion');
    // IDs are generated UUIDs; verify the exact private home before touching any owned resource.
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bot.id)
      || path.resolve(bot.homeDir) !== path.resolve(options.dataDir, 'bots', bot.id)) {
      throw new Error('Invalid Bot data directory');
    }
    const scopeId = botScopeId(bot.id);
    await options.deleteAgentScope(bot);
    await options.releaseRemoteScope(scopeId);
    const identity: RecoveryIdentity = {
      authorityId: scopeId, workspaceId: scopeId, canonicalRoot: options.dataDir, filesystemProfile: 'host-data',
    };
    const knowledgeDir = path.join('knowledge', options.hostId);
    let names: string[];
    try { names = await readdir(path.join(options.dataDir, knowledgeDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    // Sleep's original Run refs survive Catalog cleanup and retain local-store cleanup on retry.
    const stores = new Set([scopeId, ...bot.activity.work.map(work => threadScopeId(work.threadId))]);
    for (const ownedScope of stores) {
      const storeKey = knowledgeStoreKeyForScope(ownedScope);
      await options.closeMemory(ownedScope, storeKey);
      for (const name of names.filter(name => name.startsWith(`${storeKey}.`))) await options.files.remove(identity, path.join(knowledgeDir, name), { force: true });
      const vectorScope = knowledgeVectorScopeKey(scopeOfScopeId(ownedScope), ownedScope);
      await options.files.remove(identity, path.join(knowledgeDir, 'semantic', vectorScope.scopeKind, vectorScope.scopeId), { recursive: true, force: true });
    }
    await options.files.remove(identity, path.join('bots', bot.id), { recursive: true, force: true });
  };
}
