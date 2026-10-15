import type { ChatMemoryOwner, ThreadMemoryAPI, ThreadMemoryPassage, ThreadMemorySelection } from '@varin/application-client';
import { KnowledgeMutationError, MEMORY_NATURES } from '../knowledge/store.js';
import { botScopeId } from '../harness/owner-scope.js';
import type { MemoryService } from './memory-service.js';
import type { BotHistory } from './bot-history.js';
import type { MemorySelectionRequest } from './memory-inference.js';
import { parseSelectionMemories, SELECTION_MEMORY_SYSTEM } from './selection-memory.js';
export function createThreadMemory(options: {
    history: BotHistory;
    memory: MemoryService;
    narrate(scopeId: string, system: string, prompt: string, signal: AbortSignal, selection: MemorySelectionRequest): Promise<string>;
}): ThreadMemoryAPI {
    const identity = (input: ThreadMemorySelection) => {
        if (!input || input.runtime !== 'agent' || !input.threadId || !input.branchId || typeof input.headId !== 'string' || !input.headId)
            throw new KnowledgeMutationError('invalid', 'Select an original Thread history head');
    };
    const owner = async (input: ThreadMemorySelection): Promise<ChatMemoryOwner> => {
        identity(input);
        return { scope: 'bot', ownerId: await options.history.owner(input) };
    };
    const target = async (input: ThreadMemorySelection & {
        expectedOwner: ChatMemoryOwner;
        target: 'owner' | 'user';
    }) => {
        const actual = await owner(input);
        if (!input.expectedOwner || input.expectedOwner.scope !== actual.scope || input.expectedOwner.ownerId !== actual.ownerId)
            throw new KnowledgeMutationError('conflict', 'The Thread memory owner changed');
        if (input.target !== 'owner' && input.target !== 'user')
            throw new KnowledgeMutationError('invalid', 'Choose a memory destination');
        return input.target === 'user' ? { scope: 'user' as const, ownerId: null } : actual;
    };
    const validate = async (input: ThreadMemorySelection, sources: ThreadMemoryPassage[], requireRevision: boolean, signal?: AbortSignal) => {
        const botId = await options.history.owner(input, signal);
        if (!Array.isArray(sources) || !sources.length)
            throw new KnowledgeMutationError('invalid', 'Select original message text');
        return Promise.all(sources.map(async (passage) => {
            if (!passage || typeof passage.itemId !== 'string' || !passage.itemId || !Number.isSafeInteger(passage.start) || passage.start < 0
                || typeof passage.text !== 'string' || !passage.text.trim() || requireRevision && typeof passage.revision !== 'string')
                throw new KnowledgeMutationError('invalid', 'Invalid selected history passage');
            const current = await options.history.read(botId, { kind: 'history-item', threadId: input.threadId,
                branchId: input.branchId, headId: input.headId, id: passage.itemId, revision: passage.revision ?? '', start: passage.start, end: passage.start + passage.text.length }, signal);
            if (passage.revision !== undefined && passage.revision !== current.span.revision
                || current.text.slice(passage.start, passage.start + passage.text.length) !== passage.text)
                throw new KnowledgeMutationError('conflict', 'The original passage changed; select it again');
            return { role: current.role, span: current.span, passage: { ...passage, revision: current.span.revision } };
        }));
    };
    return {
        async preview(input, signal = new AbortController().signal) {
            const actual = await owner(input);
            if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.retryOf !== undefined
                && (typeof input.retryOf !== 'string' || !input.retryOf.trim() || input.retryOf === input.requestKey))
                throw new KnowledgeMutationError('invalid', 'A stable selection request identity is required');
            const passages = await validate(input, input.sources, false, signal);
            const prompt = JSON.stringify({ passages: passages.map((source, index) => ({ id: `s${index}`, role: source.role, text: source.passage.text })) });
            const text = await options.narrate(botScopeId(actual.ownerId!), SELECTION_MEMORY_SYSTEM, prompt, signal, { requestKey: input.requestKey, ...(input.retryOf ? { retryOf: input.retryOf } : {}), conversation: {
                    runtime: 'agent', threadId: input.threadId, branchId: input.branchId, headId: input.headId,
                }, sources: passages.map(source => source.span) });
            signal.throwIfAborted();
            await validate(input, passages.map(source => source.passage), true, signal);
            return { owner: actual, requestKey: input.requestKey, drafts: parseSelectionMemories(text, passages) };
        },
        async save(input) {
            const actual = await target(input);
            const draft = input.draft;
            if (!draft || typeof draft.content !== 'string' || !draft.content.trim() || typeof draft.trigger !== 'string' || !MEMORY_NATURES.includes(draft.nature))
                throw new KnowledgeMutationError('invalid', 'A memory statement and recall cue are required');
            const sources = await validate(input, draft.sources, true);
            const result = await options.memory.remember(actual, { content: draft.content, trigger: draft.trigger, nature: draft.nature,
                source: { kind: 'user-extracted', threadId: input.threadId, spans: sources.map(source => source.span) } });
            return { created: result.created, owner: actual, item: result.item };
        },
        async undo(input) {
            const actual = await target(input);
            if (!Number.isSafeInteger(input.id) || input.id <= 0 || !input.expected || typeof input.expected.content !== 'string'
                || typeof input.expected.trigger !== 'string' || input.expected.status !== 'accepted'
                || input.expected.invalidAt !== null && typeof input.expected.invalidAt !== 'number')
                throw new KnowledgeMutationError('invalid', 'The exact saved revision is required to undo');
            const { item } = await options.memory.get(actual, input.id);
            if (item.source?.kind !== 'user-extracted' || item.source.threadId !== input.threadId
                || !item.source.spans?.some(span => span.kind === 'history-item' && span.threadId === input.threadId && span.branchId === input.branchId))
                throw new KnowledgeMutationError('conflict', 'This memory was not saved from this Thread selection');
            await options.memory.forget(actual, input.id, input.expected);
            return { undone: true };
        },
    };
}
