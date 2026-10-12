import type { MemorySourceSpan } from '@varin/protocol';
import { threadMemorySourceText, type ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KnowledgeMutationError } from '../knowledge/store.js';
import { sourceRevision } from './memory-sources.js';
export interface HistoryMemoryMaterial {
    span: Extract<MemorySourceSpan, {
        kind: 'history-item';
    }>;
    text: string;
    role: string;
}
export function createBotHistory(runtime: AgentRuntimeClient) {
    const owner = async (identity: ThreadIdentity, signal?: AbortSignal): Promise<string> => {
        if (identity.runtime !== 'agent')
            throw new KnowledgeMutationError('invalid', 'An Agent Thread identity is required');
        const thread = await runtime.thread(identity.threadId, signal);
        if (!thread.bot_id || !thread.branches.some(branch => branch.branch_id === identity.branchId))
            throw new KnowledgeMutationError('invalid', 'This conversation is not owned by a Bot');
        return thread.bot_id;
    };
    const read = async (botId: string, span: Extract<MemorySourceSpan, {
        kind: 'history-item';
    }>, signal?: AbortSignal): Promise<HistoryMemoryMaterial> => {
        const item = await runtime.botHistory({ botId, threadId: span.threadId, branchId: span.branchId, headId: span.headId, itemId: span.id }, signal);
        const text = threadMemorySourceText(item);
        return { span: { ...span, revision: sourceRevision(text) }, text, role: item.source };
    };
    const branch = async (identity: ThreadIdentity, headId?: string, signal?: AbortSignal): Promise<HistoryMemoryMaterial[]> => {
        const botId = await owner(identity, signal);
        const result: HistoryMemoryMaterial[] = [];
        let before: string | undefined;
        let head = headId;
        do {
            const page = await runtime.historyPage({ branchId: identity.branchId, limit: 100, ...(head ? { headId: head } : {}), ...(before ? { beforeId: before } : {}) }, signal);
            head = page.head ?? undefined;
            if (!head)
                return [];
            const block: HistoryMemoryMaterial[] = [];
            for (const reference of page.items) {
                const source = await read(botId, { kind: 'history-item', id: reference.id, threadId: reference.thread_id,
                    branchId: identity.branchId, headId: head, revision: '', start: 0, end: 1 }, signal);
                if (source.text)
                    block.push({ ...source, span: { ...source.span, end: source.text.length } });
            }
            result.unshift(...block);
            before = page.previous ?? undefined;
        } while (before);
        return result;
    };
    const bot = async (botId: string, signal?: AbortSignal): Promise<HistoryMemoryMaterial[]> => {
        const scope = await runtime.botScope(botId, signal);
        const sources = new Map<string, HistoryMemoryMaterial>();
        for (const thread of scope.threads)
            for (const witness of thread.branches) {
                if (!witness.head)
                    continue;
                for (const material of await branch({ runtime: 'agent', threadId: thread.thread_id, branchId: witness.branch_id }, witness.head, signal)) {
                    if (material.role === 'user' || material.role === 'assistant')
                        sources.set(JSON.stringify([material.span.threadId, material.span.id]), material);
                }
            }
        return [...sources.values()];
    };
    return { owner, read, branch, bot };
}
export type BotHistory = ReturnType<typeof createBotHistory>;
