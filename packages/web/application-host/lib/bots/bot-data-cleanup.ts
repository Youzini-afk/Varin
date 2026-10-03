import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BotSummary } from '@varin/application-client';
import type { ThreadRegistry } from '../harness/thread-registry.js';
import type { ThreadRuntime } from '../harness/thread-runtime.js';
import { botScopeId, knowledgeStoreKeyForScope } from '../harness/owner-scope.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { knowledgeVectorScopeKey } from '../knowledge/vectors/store.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';

/** Called only after durable Bot admission is closed and its sleep operation completed. */
export function createBotDataCleanup(options: {
  dataDir: string;
  hostId: string;
  registry: Pick<ThreadRegistry, 'listWorkspaceThreadSnapshots' | 'listWorkspaceRunSessionIds'>;
  deleteThread: ThreadRuntime['deleteUser'];
  deleteSession(sessionId: string): Promise<unknown>;
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
    const snapshots = await options.registry.listWorkspaceThreadSnapshots(scopeId);
    const sessions = new Set([
      ...(bot.entrySessionId ? [bot.entrySessionId] : []),
      ...bot.activity.work.flatMap((item) => item.sessionId ? [item.sessionId] : []),
      ...await options.registry.listWorkspaceRunSessionIds(scopeId),
    ]);
    const ids = new Set(snapshots.map(({ thread }) => thread.id));
    for (const { thread } of snapshots) {
      if (thread.parent.kind === 'thread' && ids.has(thread.parent.id)) continue;
      const result = await options.deleteThread(scopeId, thread.parent, thread.id);
      if (result.status !== 'complete') {
        throw new Error(result.nodeResults.filter((node) => node.status !== 'complete')
          .map((node) => `${node.threadId}: ${node.error ?? node.status}`).join('\n'));
      }
    }
    if ((await options.registry.listWorkspaceThreadSnapshots(scopeId)).length) throw new Error('Bot work cleanup is incomplete');
    // Native Pi deletion owns transcripts and closes their follow-ups. Never unlink JSONL here.
    for (const sessionId of sessions) await options.deleteSession(sessionId);
    await options.releaseRemoteScope(scopeId);
    const storeKey = knowledgeStoreKeyForScope(scopeId);
    await options.closeMemory(scopeId, storeKey);
    const identity: RecoveryIdentity = {
      authorityId: scopeId, workspaceId: scopeId, canonicalRoot: options.dataDir, filesystemProfile: 'host-data',
    };
    const knowledgeDir = path.join('knowledge', options.hostId);
    let names: string[];
    try { names = await readdir(path.join(options.dataDir, knowledgeDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    // Trivium uses several generation/sidecar extensions; the opaque store key owns this prefix.
    for (const name of names.filter((name) => name.startsWith(`${storeKey}.`))) {
      await options.files.remove(identity, path.join(knowledgeDir, name), { force: true });
    }
    const vectorScope = knowledgeVectorScopeKey('bot', scopeId);
    await options.files.remove(identity, path.join(knowledgeDir, 'semantic', vectorScope.scopeKind, vectorScope.scopeId), { recursive: true, force: true });
    await options.files.remove(identity, path.join('bots', bot.id), { recursive: true, force: true });
  };
}
