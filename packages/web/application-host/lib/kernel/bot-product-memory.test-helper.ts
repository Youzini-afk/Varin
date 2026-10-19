/** Installs the original Bot memory owners in the established stdio fixture. No listener. */
import assert from 'node:assert/strict';
import { openWorkspaceKnowledge, type KnowledgeStore } from '../knowledge/store.js';
import { createKnowledgeContextRuntime } from '../knowledge/context-runtime.js';
import { createMemoryService } from '../memory/memory-service.js';
import { createBotHistory } from '../memory/bot-history.js';
import { botScopeId, knowledgeStoreKeyForScope, scopeOfScopeId, threadScopeId } from '../harness/owner-scope.js';
import { createMemoryOwner } from './memory-owner.js';
import { createBotMemoryOwner } from './bot-memory-owner.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { createThreadContext, type ContextPreparer } from './thread-context.js';
import { resourceScopeFixture } from './resource-scope.test-helper.js';
import type { BotService } from '../bots/bot-service.js';
export async function installProductMemory(root: string, kernel: KernelClient, runtime: AgentRuntimeClient, bots: BotService): Promise<{
    close(): Promise<void>;
    context: ContextPreparer;
}> {
    const stores = new Map<string, Promise<KnowledgeStore>>();
    const store = (scope: string): Promise<KnowledgeStore> => {
        let current = stores.get(scope);
        if (!current) {
            current = openWorkspaceKnowledge({ dataDir: root, hostId: 'web-domain-host', workspaceId: knowledgeStoreKeyForScope(scope), scope: scopeOfScopeId(scope), embedding: null });
            stores.set(scope, current);
        }
        return current;
    };
    const ownerForThread = async (id: string) => {
        const thread = await runtime.thread(id);
        assert(thread.bot_id);
        return { scope: 'bot' as const, ownerId: thread.bot_id };
    };
    const history = createBotHistory(runtime);
    const memory = createMemoryService({ storeForScopeId: store, userStore: () => store('user'),
        ownerForThread,
        threadStoreIfPresent: id => store(threadScopeId(id)), associationForThread: async (id) => ({ threadIds: [id] }),
        readHistorySource: async (botId, span) => (await history.read(botId, span)).text,
    });
    const knowledge = createKnowledgeContextRuntime({ getStore: store, getUserStore: () => store('user'), getThreadStore: id => store(threadScopeId(id)),
        recallForThread: async ({ threadId, query }) => memory.search(await ownerForThread(threadId), query, 8, { threadId, includeShared: true }),
    });
    const prepareContext = createThreadContext({ resources: resourceScopeFixture(root, {} as never),
        personalization: { catalog: async () => { throw new Error('Bot must not read ordinary notes'); } }, projectForWorkspace: async () => undefined,
        botForThread: async (id) => {
            const botId = (await runtime.thread(id)).bot_id;
            if (!botId)
                return null;
            const bot = await bots.get(botId);
            assert(bot);
            return { id: bot.id, name: bot.name, instructions: bot.instructions, revision: (await bots.executionGate(botId)).profileRevision };
        },
    });
    kernel.setMemoryOwner(createMemoryOwner({ personalization: {} as never, prepareContext,
        bot: createBotMemoryOwner({ runtime, history, memory, prepareContext, knowledge: knowledge.knowledgeForThread }),
    }));
    kernel.setContextOwner({
        query: async query => { assert.equal(query.action, 'prepare'); return { status: 'ready' }; },
        close() {},
    });
    // An independent actual Bot store contains a tempting row. It must never enter this Bot's request.
    await memory.remember({ scope: 'bot', ownerId: 'unrelated-bot' }, { content: 'OTHER_BOT_SECRET', trigger: 'recovery evidence', source: { kind: 'user-extracted' } });
    assert(await store(botScopeId('unrelated-bot')));
    return { context: prepareContext, close: async () => { for (const pending of stores.values())
            await (await pending).close(); } };
}
