import type { MemorySourceSpan } from '@varin/protocol';
import { threadMemorySourceText, type ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KnowledgeMutationError } from '../knowledge/store.js';
import { sourceRevision } from './memory-sources.js';
export interface HistoryMemoryMaterial {
    /** Canonical source of an attributed incoming work update; the actual item remains the read witness. */
    originalId?: string;
    span: Extract<MemorySourceSpan, {
        kind: 'history-item';
    }>;
    text: string;
    role: string;
}
export interface HistoryMemoryBatch {
    materials: HistoryMemoryMaterial[];
    heads: Record<string, string>;
    hasMore?: boolean;
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
        const body=item.content as { content?: { kind?: string; output?: { data?: { kind?: string; source?: { itemId?: string } } } } } | null;
        const data=body?.content?.output?.data;
        const originalId=data?.kind==='work_update' ? data.source?.itemId : undefined;
        return { span: { ...span, revision: sourceRevision(text) }, text, role: item.source, ...(originalId?{originalId}:{}) };
    };
    const branch = async (identity: ThreadIdentity, headId?: string, signal?: AbortSignal,
        afterId?: string, conversationOnly = false, sourceBotId?: string): Promise<HistoryMemoryMaterial[]> => {
        const botId = sourceBotId ?? await owner(identity, signal);
        const result: HistoryMemoryMaterial[] = [];
        let before: string | undefined;
        let head = headId;
        do {
            const page = await runtime.historyPage({ branchId: identity.branchId, limit: 100, ...(head ? { headId: head } : {}),
                ...(before ? { beforeId: before } : {}), ...(afterId ? { afterId } : {}) }, signal);
            head = page.head ?? undefined;
            if (!head)
                return [];
            const block: HistoryMemoryMaterial[] = [];
            for (const reference of page.items) {
                if (conversationOnly && reference.source !== 'user' && reference.source !== 'assistant') continue;
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
    const recent = async (identity: ThreadIdentity, signal?: AbortSignal): Promise<HistoryMemoryMaterial[]> => {
        const botId = await owner(identity, signal);
        const found = new Map<string, HistoryMemoryMaterial>();
        let before: string | undefined;
        let head: string | undefined;
        do {
            const page = await runtime.historyPage({ branchId: identity.branchId, limit: 100,
                ...(head ? { headId: head } : {}), ...(before ? { beforeId: before } : {}) }, signal);
            head = page.head ?? undefined;
            if (!head) return [];
            for (const reference of [...page.items].reverse()) {
                // The latest exchange and actual incoming event explain short continuations
                // and background wakeups. Tool transcripts stay on their original reader.
                const role = reference.source;
                if (role === 'user' && found.has('user')) return [...found.values()].reverse();
                const key = role === 'agent' || role === 'environment' ? 'incoming' : role;
                if (!['user', 'assistant', 'incoming'].includes(key) || found.has(key)) continue;
                const material = await read(botId, { kind: 'history-item', id: reference.id,
                    threadId: reference.thread_id, branchId: identity.branchId, headId: head,
                    revision: '', start: 0, end: 1 }, signal);
                if (material.text) found.set(key, { ...material, span: { ...material.span, end: material.text.length } });
                if (found.has('user') && found.has('assistant')) break;
            }
            if (found.has('user') && found.has('assistant')) break;
            before = page.previous ?? undefined;
        } while (before);
        return [...found.values()].reverse();
    };
    const sourceScope = async (botId: string, signal?: AbortSignal) => {
        const scope = await runtime.botScope(botId, signal, true);
        const followed = (await runtime.botMatters(botId, signal)).filter(matter => !matter.archived)
            .flatMap(matter => matter.threads.filter(link => link.memory));
        const owned = new Set(scope.threads.map(thread => thread.thread_id));
        for (const threadId of new Set(followed.map(link => link.threadId))) {
            if (owned.has(threadId)) continue;
            const thread = await runtime.thread(threadId, signal).catch(error => {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'not-found') return null;
                throw error;
            });
            if (!thread || thread.deleted_at_ms !== null) continue;
            scope.threads.push({ ...thread, branches: thread.branches.filter(branch => followed.some(link => link.threadId === threadId && link.branchId === branch.branch_id)) });
        }
        return scope;
    };
    const hasSources = async (botId: string, signal?: AbortSignal) => {
        for (const thread of (await sourceScope(botId, signal)).threads) for (const branch of thread.branches) {
            if (!branch.head) continue;
            let before: string | undefined;
            do {
                const page = await runtime.historyPage({ branchId: branch.branch_id, headId: branch.head, limit: 100, ...(before ? { beforeId: before } : {}) }, signal);
                if (page.items.some(item => item.source === 'user' || item.source === 'assistant')) return true;
                before = page.previous ?? undefined;
            } while (before);
        }
        return false;
    };
    // Retain the current immutable batch while its source ranges settle. A cursor,
    // source witness or model-budget change replaces it, including across Bot switches.
    let cachedBatch: { key: string; batch: HistoryMemoryBatch } | undefined;
    const botBatch = async (botId: string, afterHeads: Readonly<Record<string, string>> = {}, signal?: AbortSignal,
        sourceChars = Number.POSITIVE_INFINITY): Promise<HistoryMemoryBatch> => {
        const scope = await sourceScope(botId, signal);
        const cacheKey = JSON.stringify([botId, afterHeads, sourceChars, scope.threads.map(thread => [thread.thread_id, thread.branches.map(branch => [branch.branch_id, branch.head])])]);
        if (Number.isFinite(sourceChars) && cachedBatch?.key === cacheKey) return cachedBatch.batch;
        const sources = new Map<string, HistoryMemoryMaterial>();
        const heads: Record<string, string> = {};
        let chars = 0;
        let hasMore = false;
        for (const thread of scope.threads)
            for (const witness of thread.branches) {
                if (!witness.head)
                    continue;
                if (afterHeads[witness.branch_id] === witness.head) { heads[witness.branch_id] = witness.head; continue; }
                if (chars >= sourceChars) { hasMore = true; continue; }
                // Enumerate only metadata since the durable boundary, then hydrate oldest
                // first. The model's actual budget bounds body reads, not a fixed message count.
                const references: Awaited<ReturnType<AgentRuntimeClient['historyPage']>>['items'] = [];
                let before: string | undefined;
                do {
                    const page = await runtime.historyPage({ branchId: witness.branch_id, headId: witness.head, limit: 100,
                        ...(before ? { beforeId: before } : {}),
                        ...(afterHeads[witness.branch_id] ? { afterId: afterHeads[witness.branch_id] } : {}) }, signal);
                    references.unshift(...page.items);
                    before = page.previous ?? undefined;
                } while (before);
                for (const reference of references) {
                    if (chars >= sourceChars) { hasMore = true; break; }
                    if (reference.source === 'user' || reference.source === 'assistant') {
                        const material = await read(botId, { kind: 'history-item', id: reference.id, threadId: reference.thread_id,
                            branchId: witness.branch_id, headId: witness.head, revision: '', start: 0, end: 1 }, signal);
                        if (material.text) {
                            sources.set(JSON.stringify([material.span.threadId, material.span.id]), { ...material, span: { ...material.span, end: material.text.length } });
                            chars += material.text.length;
                        }
                    }
                    heads[witness.branch_id] = reference.id;
                }
            }
        const batch = { materials: [...sources.values()], heads, hasMore };
        cachedBatch = Number.isFinite(sourceChars) ? { key: cacheKey, batch } : undefined;
        return batch;
    };
    const bot = async (botId: string, signal?: AbortSignal) => (await botBatch(botId, {}, signal)).materials;
    return { owner, read, branch, recent, bot, botBatch, hasSources };
}
export type BotHistory = ReturnType<typeof createBotHistory>;
