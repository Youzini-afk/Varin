import type { KnowledgeRecallMaterial, KnowledgeRecallItem } from '../knowledge/recall-material.js';
import type { MemorySourceSpan, MemoryNature } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextPreparer } from './thread-context.js';
import type { MemoryResult, MemoryToolOwner } from './memory-owner.js';
import type { BotHistory } from '../memory/bot-history.js';
import type { MemoryOwner, MemoryService } from '../memory/memory-service.js';
import { KnowledgeMutationError, type KnowledgeExpectedRevision } from '../knowledge/store.js';
import { botScopeId } from '../harness/owner-scope.js';
interface BotKnowledgeState {
    botId: string;
    threadId: string;
    items: KnowledgeRecallItem[];
    invalidations: Array<{
        id: number;
        scope: 'bot' | 'user' | 'session';
    }>;
    corrections: NonNullable<KnowledgeRecallMaterial['knowledgeCorrections']>;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left.localeCompare(right))) : part);
const invalid = (message: string): never => { throw new KnowledgeMutationError('invalid', message); };
const key = (item: {
    scope?: string;
    id: number;
}) => `knowledge:${item.scope}:${item.id}`;
export function createBotMemoryOwner(options: {
    runtime: AgentRuntimeClient;
    history: BotHistory;
    memory: MemoryService;
    prepareContext: ContextPreparer;
    knowledge(input: {
        threadId: string;
        scopeId: string;
        query: string;
        knownMaterial: Record<string, string>;
        signal: AbortSignal;
    }): Promise<KnowledgeRecallMaterial>;
}): MemoryToolOwner {
    return async (query, signal): Promise<MemoryResult> => {
        let mutationStarted = false;
        try {
            // Re-read original authority. The private frame's mode is not a Bot credential.
            const lookupSignal = query.action === 'receipt' ? undefined : signal;
            const run = await options.runtime.run(query.runId, lookupSignal);
            const thread = await options.runtime.thread(run.thread_id, lookupSignal);
            const botId = thread.bot_id;
            if (!botId || query.scope.threadId !== run.thread_id || query.scope.botId !== botId)
                invalid('Memory scope differs from the original Bot Run');
            const identity = { runtime: 'agent' as const, threadId: run.thread_id, branchId: run.branch_id };
            if (query.action === 'synchronize') {
                if (!query.checkpoint?.personalization || !options.prepareContext.refresh)
                    invalid('Bot context is not admitted');
                const checkpoint = query.checkpoint!;
                if (checkpoint.personalization!.mode !== 'bot' || checkpoint.personalization!.threadId !== run.thread_id)
                    invalid('Bot context owner changed');
                const context = await options.prepareContext.refresh!(checkpoint, signal);
                const previous = record(query.previousState);
                const prior = record(previous.botKnowledge) as unknown as Partial<BotKnowledgeState>;
                if (prior.botId && (prior.botId !== botId || prior.threadId !== run.thread_id))
                    invalid('Retained memory belongs to another Bot');
                const retained = prior.items ?? [];
                const history = await options.history.branch(identity, undefined, signal);
                const latest = [...history].reverse().find(item => item.role === 'user')?.text ?? '';
                const material = await options.knowledge({ threadId: run.thread_id, scopeId: botScopeId(botId!), query: latest,
                    knownMaterial: Object.fromEntries(retained.map(item => [key(item), JSON.stringify(item)])), signal });
                const items = new Map(retained.map(item => [key(item), item]));
                const invalidations = new Map((prior.invalidations ?? []).map(item => [key(item), item]));
                const corrections = new Map((prior.corrections ?? []).map(item => [key(item), item]));
                for (const item of material.knowledgeInvalidations ?? []) {
                    if (item.scope !== 'bot' && item.scope !== 'user' && item.scope !== 'session')
                        invalid('Bot recall returned another owner scope');
                    items.delete(key(item));
                    corrections.delete(key(item));
                    invalidations.set(key(item), item as {
                        id: number;
                        scope: 'bot' | 'user' | 'session';
                    });
                }
                for (const item of [...material.knowledge, ...(material.knowledgeCorrections ?? [])]) {
                    if (item.scope !== 'bot' && item.scope !== 'user' && item.scope !== 'session')
                        invalid('Bot recall returned another owner scope');
                    items.set(key(item), item);
                    invalidations.delete(key(item));
                }
                for (const item of material.knowledgeCorrections ?? [])
                    corrections.set(key(item), item);
                const botKnowledge: BotKnowledgeState = { botId: botId!, threadId: run.thread_id, items: [...items.values()], invalidations: [...invalidations.values()], corrections: [...corrections.values()] };
                const oldRevision = typeof previous.revision === 'number' ? previous.revision : 0;
                const revision = canonical(botKnowledge) === canonical(prior) ? oldRevision : oldRevision + 1;
                signal.throwIfAborted();
                return { status: 'ready', context, state: { revision, memories: [], noteRevisions: {}, botKnowledge } };
            }
            const args = record(query.arguments);
            const action = args.action;
            if (!['get', 'search', 'recall', 'remember', 'correct', 'forget'].includes(String(action)))
                invalid('Unknown Bot memory action');
            if (args.scope !== undefined && args.scope !== 'bot' && args.scope !== 'user' && args.scope !== 'session')
                invalid('Bot memory scope must be bot, user or session');
            const owner: MemoryOwner = args.scope === 'user' ? { scope: 'user', ownerId: null } : args.scope === 'session' ? { scope: 'session', ownerId: run.thread_id } : { scope: 'bot', ownerId: botId! };
            const id = args.id;
            if (['get', 'correct', 'forget'].includes(String(action)) && (!Number.isSafeInteger(id) || (id as number) <= 0))
                invalid('Memory id must be a positive integer');
            if (action === 'get') {
                const result = await options.memory.get(owner, id as number);
                return { status: 'ready', ...result, ...(args.includeSource ? { sources: await options.memory.readSource(owner, id as number, botId!) } : {}) };
            }
            if (action === 'search' || action === 'recall')
                return { status: 'ready', results: await options.memory.search(owner, typeof args.query === 'string' ? args.query : '', typeof args.k === 'number' ? args.k : 8, { threadId: run.thread_id, includeShared: args.scope === undefined }) };
            if (query.scope.threadRole === 'read-only')
                invalid('This Bot child has read-only memory authority');
            if (!query.origin)
                invalid('Memory mutation requires its original Operation');
            const origin = { id: query.origin!, intent: canonical({ botId, threadId: run.thread_id, owner, arguments: args }) };
            const prior = await options.memory.mutationReceipt(owner, origin);
            if (prior || query.action === 'receipt')
                return { status: 'ready', memoryReceipt: prior };
            signal.throwIfAborted();
            const expected = args.expected as KnowledgeExpectedRevision | undefined;
            if ((action === 'correct' || action === 'forget') && (!expected || typeof expected.content !== 'string' || typeof expected.trigger !== 'string'
                || !['suggested', 'accepted', 'dismissed'].includes(expected.status ?? '') || !(expected.invalidAt === null || typeof expected.invalidAt === 'number')))
                invalid('Read the row first and supply its exact expected values');
            if (action === 'forget') {
                mutationStarted = true;
                await options.memory.forget(owner, id as number, expected, origin);
            }
            else {
                if (typeof args.content !== 'string' || !args.content.trim())
                    invalid('Memory content is required');
                const content = args.content as string;
                const quote = typeof args.sourceText === 'string' ? args.sourceText : content;
                const materials = await options.history.branch(identity, undefined, signal);
                const matches = materials.filter(item => (!args.sourceItemId || item.span.id === args.sourceItemId) && item.text.includes(quote));
                const source = matches.at(-1);
                if (!source || !quote.trim())
                    invalid('Provide sourceText as an exact original history passage and sourceItemId when needed');
                if (args.nature === 'instruction' && source!.role !== 'user')
                    invalid('Only a user statement can establish an instruction');
                const start = source!.text.indexOf(quote);
                const span: MemorySourceSpan = { ...source!.span, start, end: start + quote.length };
                const patch = { content, trigger: typeof args.trigger === 'string' ? args.trigger : '',
                    ...(args.nature ? { nature: args.nature as MemoryNature } : {}), source: { kind: 'agent-memory', threadId: run.thread_id, runId: run.id, spans: [span] } };
                signal.throwIfAborted();
                mutationStarted = true;
                if (action === 'remember')
                    await options.memory.remember(owner, patch, origin);
                else
                    await options.memory.correct(owner, id as number, { ...patch, expected: expected! }, origin);
            }
            // No abortable wrapper: the original mutation owner must settle before Sleep drains.
            return { status: 'ready', memoryReceipt: await options.memory.mutationReceipt(owner, origin) };
        }
        catch (error) {
            return { status: error instanceof KnowledgeMutationError ? 'rejected' : 'unknown', ...(!mutationStarted && query.action === 'tool' ? { mutationNotStarted: true as const } : {}), message: error instanceof Error ? error.message : 'Bot memory result is unconfirmed' };
        }
    };
}
