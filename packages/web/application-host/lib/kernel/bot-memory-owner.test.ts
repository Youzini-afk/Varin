import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceKnowledge } from '../knowledge/store.js';
import { createKnowledgeContextRuntime } from '../knowledge/context-runtime.js';
import { createMemoryService } from '../memory/memory-service.js';
import { createBotHistory } from '../memory/bot-history.js';
import { createBotMemoryOwner } from './bot-memory-owner.js';
import { createMemoryOwner, type MemoryQuery } from './memory-owner.js';
import { MemoryBridge, type PrivateMemoryResponse } from './memory-bridge.js';
import { sourceRevision } from '../memory/memory-sources.js';
it('captures real Knowledge correction then forgetting at the Bot request-material owner', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'varin-bot-correction-review-'));
    const store = await openWorkspaceKnowledge({ dataDir, hostId: 'test-host', workspaceId: 'bot-test', scope: 'bot', embedding: null });
    try {
        const memoryOwner = { scope: 'bot' as const, ownerId: 'test-bot' };
        const memory = createMemoryService({ storeForScopeId: async () => store, userStore: async () => null,
            ownerForThread: async () => memoryOwner, associationForThread: async (threadId) => ({ threadIds: [threadId] }) });
        const knowledge = createKnowledgeContextRuntime({ getStore: async () => store,
            recallForThread: async ({ query, threadId }) => memory.search(memoryOwner, query, 8, { threadId }) });
        const runtime = { run: async () => ({ id: 'run', thread_id: 'thread', branch_id: 'main' }), thread: async () => ({ bot_id: 'test-bot' }) };
        const owner = createBotMemoryOwner({ runtime: runtime as never, memory,
            history: { branch: async () => [{ role: 'user', text: 'continue' }] } as never,
            prepareContext: { refresh: async () => ({}) } as never, knowledge: knowledge.knowledgeForThread });
        const states: unknown[] = [];
        const sync = async () => {
            const result = await owner({ action: 'synchronize', runId: 'run', scope: { botId: 'test-bot', mode: 'bot', threadId: 'thread', projectId: null },
                previousState: states.at(-1), checkpoint: { personalization: { mode: 'bot', threadId: 'thread' } } as never }, new AbortController().signal);
            expect(result.status).toBe('ready');
            if (result.status !== 'ready')
                throw new Error(result.message);
            states.push(result.state);
            return (result as unknown as {
                state: {
                    botKnowledge: {
                        items: unknown[];
                        corrections: unknown[];
                        invalidations: unknown[];
                    };
                };
            }).state;
        };
        const first = await memory.remember(memoryOwner, { content: 'OLD launch requirement', source: { kind: 'user-extracted', threadId: 'thread' } });
        await sync();
        const updated = await memory.correct(memoryOwner, first.item.id, { content: 'FORGOTTEN_CORRECTION_BODY', source: { kind: 'user-extracted', threadId: 'thread' } });
        expect((await sync()).botKnowledge.corrections).toHaveLength(1);
        await memory.forget(memoryOwner, updated.id);
        const final = await sync();
        expect(final.botKnowledge.items).toEqual([]);
        expect(final.botKnowledge.invalidations).toContainEqual({ id: updated.id, scope: 'bot' });
        expect(final.botKnowledge.corrections).toEqual([]);
    }
    finally {
        await store.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
it('reads a committed original receipt with an aborted caller but aborts a not-yet-dispatched forget', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'varin-bot-receipt-review-'));
    const store = await openWorkspaceKnowledge({ dataDir, hostId: 'fixture', workspaceId: 'bot', scope: 'bot', embedding: null });
    let release!: () => void;
    try {
        const target = { scope: 'bot' as const, ownerId: 'bot' };
        const memory = createMemoryService({ storeForScopeId: async () => store, userStore: async () => null, ownerForThread: async () => target });
        const text = 'Preserve the original signed deployment decision.';
        const runtime = { run: async (_id: string, signal?: AbortSignal) => { signal?.throwIfAborted(); return { id: 'run', thread_id: 'thread:bot', branch_id: 'branch', state: 'waiting' }; }, thread: async (_id: string, signal?: AbortSignal) => { signal?.throwIfAborted(); return { bot_id: 'bot' }; } };
        const history = { branch: async () => [{ role: 'user', text, span: { kind: 'history-item', id: 'user', threadId: 'thread:bot', branchId: 'branch', headId: 'user', revision: sourceRevision(text), start: 0, end: text.length } }] };
        const prepareContext = {} as never;
        let enter!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const mutationReceipt = memory.mutationReceipt.bind(memory);
        const owner = createMemoryOwner({ personalization: {} as never, prepareContext,
            bot: createBotMemoryOwner({ runtime: runtime as never, history: history as never, prepareContext, knowledge: async () => { throw new Error('No recall'); }, memory: { ...memory, mutationReceipt: async (scope, origin) => {
                        const result = await mutationReceipt(scope, origin);
                        if (origin.id === 'cancelled-forget') {
                            enter();
                            await held;
                        }
                        return result;
                    } } }) });
        const scope = { mode: 'bot' as const, threadId: 'thread:bot', projectId: null, botId: 'bot', threadRole: 'main' };
        const args: NonNullable<MemoryQuery['arguments']> = { action: 'remember', content: text, sourceText: text, nature: 'instruction' };
        const saved = await owner({ action: 'tool', runId: 'run', scope, origin: 'original-operation', arguments: args }, new AbortController().signal);
        expect(saved.status).toBe('ready');
        if (saved.status !== 'ready')
            throw new Error(saved.message);
        expect(saved.memoryReceipt).not.toBeNull();
        const cancelled = new AbortController();
        cancelled.abort(new Error('Bot domain suspended'));
        const observed = await owner({ action: 'receipt', runId: 'run', scope, origin: 'original-operation', arguments: args }, cancelled.signal);
        expect(observed).toEqual(saved);
        const row = (await memory.list(target))[0]!;
        const stopping = new AbortController();
        const forget = owner({ action: 'tool', runId: 'run', scope, origin: 'cancelled-forget', arguments: { action: 'forget', id: row.id, expected: { content: row.content, trigger: row.trigger, status: row.status, invalidAt: row.invalidAt ?? null } } }, stopping.signal);
        await entered;
        stopping.abort(new Error('Sleep before any new forget write'));
        release();
        expect((await forget).status).toBe('unknown');
        expect((await memory.get(target, row.id)).item.invalidAt).toBeUndefined();
    }
    finally {
        release?.();
        await store.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
// Match Catalog HistoryPageRead: pages travel newest to oldest; each page itself is chronological.
it('keeps the latest user recall query across the original 100-item page boundary', async () => {
    const messages = Array.from({ length: 101 }, (_, i) => ({ id: `h${i}`, thread_id: 'thread:bot', source: 'user', content: i === 100 ? 'CURRENT launch question' : `OLD question ${i}` }));
    const runtime = {
        run: async () => ({ id: 'run', thread_id: 'thread:bot', branch_id: 'branch' }),
        thread: async () => ({ bot_id: 'bot', branches: [{ branch_id: 'branch' }] }),
        historyPage: async (input: {
            beforeId?: string;
        }) => input.beforeId
            ? { head: 'h100', items: messages.slice(0, 1), previous: null }
            : { head: 'h100', items: messages.slice(1), previous: 'h1' },
        botHistory: async (input: {
            itemId: string;
        }) => messages.find(item => item.id === input.itemId),
    };
    const history = createBotHistory(runtime as never);
    const knowledge = vi.fn(async (_input: {
        query: string;
    }) => ({ knowledge: [] }));
    const prepareContext = { refresh: async () => ({}) };
    const owner = createBotMemoryOwner({ runtime: runtime as never, history, memory: {} as never, prepareContext: prepareContext as never, knowledge: knowledge as never });
    const result = await owner({ action: 'synchronize', runId: 'run', scope: { botId: 'bot', mode: 'bot', threadId: 'thread:bot', projectId: null },
        checkpoint: { personalization: { mode: 'bot', threadId: 'thread:bot' } } as never }, new AbortController().signal);
    expect(result.status).toBe('ready');
    expect(knowledge).toHaveBeenCalledOnce();
    expect(knowledge.mock.calls[0]![0]).toMatchObject({ query: 'CURRENT launch question' });
});
it('Sleep joins the original domain promise and only explicit pre-write evidence can clear Unknown', async () => {
    const responses: PrivateMemoryResponse[] = [];
    const bridge = new MemoryBridge(() => 'epoch', async (response) => { responses.push(response); }, () => { throw new Error('Unexpected transport failure'); });
    let finish!: () => void;
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const ownerWork = new Promise<void>(resolve => { finish = resolve; });
    bridge.setOwner(async (query) => {
        if (query.action === 'receipt')
            return { status: 'ready', memoryReceipt: null };
        entered();
        await ownerWork;
        return { status: 'unknown', message: 'Aborted before the mutation owner was entered', mutationNotStarted: true };
    });
    const query: MemoryQuery = { action: 'tool', runId: 'original-run', origin: 'original-operation',
        scope: { mode: 'bot', botId: 'bot', threadId: 'thread', projectId: null }, arguments: { action: 'forget', id: 1 } };
    bridge.consume({ v: 1, kind: 'memory-request', id: 'tool', kernelEpoch: 'epoch', query });
    await entry;
    bridge.consume({ v: 1, kind: 'memory-cancel', id: 'tool', kernelEpoch: 'epoch' });
    await vi.waitFor(() => expect(responses[0]?.result.status).toBe('unknown'));
    let drained = false;
    const drain = bridge.drainRuns(new Set(['original-run'])).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await drain;
    bridge.consume({ v: 1, kind: 'memory-request', id: 'receipt', kernelEpoch: 'epoch', query: { ...query, action: 'receipt' } });
    await vi.waitFor(() => expect(responses.at(-1)?.result).toMatchObject({ executionReceipt: { effect: 'none', executorStopped: true } }));
    bridge.close();
    bridge.consume({ v: 1, kind: 'memory-request', id: 'lost-proof', kernelEpoch: 'epoch', query: { ...query, action: 'receipt' } });
    await vi.waitFor(() => expect(responses.at(-1)?.id).toBe('lost-proof'));
    expect(responses.at(-1)?.result).not.toHaveProperty('executionReceipt');
});
