import type { KnowledgeRecallMaterial, KnowledgeRecallItem } from '../knowledge/recall-material.js';
import type { MemorySourceSpan, MemoryNature } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextPreparer } from './thread-context.js';
import type { MemoryResult, MemoryToolOwner } from './memory-owner.js';
import type { BotHistory } from '../memory/bot-history.js';
import type { BotRecallWork } from '../memory/bot-recall-context.js';
import type { MemoryOwner, MemoryService } from '../memory/memory-service.js';
import { KnowledgeMutationError, type KnowledgeExpectedRevision } from '../knowledge/store.js';
import { botScopeId } from '../harness/owner-scope.js';
import { sourceRevision, uncoveredSourceSpans, overlappingSource } from '../memory/memory-sources.js';
import type { createMemoryOrganizer } from '../memory/memory-organizer.js';
import { memoryExpected, memoryVersion } from '../memory/memory-maintenance-state.js';
interface BotKnowledgeState {
    botId: string;
    threadId: string;
    items: KnowledgeRecallItem[];
    invalidations: Array<{
        id: number;
        scope: 'bot' | 'user' | 'session';
    }>;
    corrections: NonNullable<KnowledgeRecallMaterial['knowledgeCorrections']>;
    exclusions?: Array<{ id: number; scope: string; sources: MemorySourceSpan[] }>;
    redactedThrough?: string;
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
    organizer?: Pick<ReturnType<typeof createMemoryOrganizer>, 'maintain' | 'maintenanceStatus' | 'cancelMaintenance'>;
    prepareContext: ContextPreparer;
    knowledge(input: {
        threadId: string;
        scopeId: string;
        query: string;
        work?: BotRecallWork[];
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
                const exclusions = (await Promise.all(([
                    { scope: 'bot', ownerId: botId! }, { scope: 'user', ownerId: null }, { scope: 'session', ownerId: run.thread_id },
                ] as MemoryOwner[]).map(async owner => (await options.memory.exclusions(owner))
                    .map(row => ({ id: row.id, scope: row.scope, sources: row.source?.spans ?? [] }))))).flat();
                const history = await options.history.recent(identity, signal);
                const work: BotRecallWork[] = [];
                const recallContext = history.map(item => {
                    const covered=exclusions.flatMap(row=>row.sources).map(span=>item.originalId===span.id?{...span,id:item.span.id,threadId:item.span.threadId}:span);
                    const text=uncoveredSourceSpans(item.span,covered).map(span=>item.text.slice(span.start,span.end)).join('\n');
                    if (text && item.work) work.push(item.work);
                    return text ? '['+item.role+'] '+text : '';
                }).filter(Boolean).join('\n\n');
                const material = await options.knowledge({ threadId: run.thread_id, scopeId: botScopeId(botId!), query: recallContext, work,
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
                const newExclusion = exclusions.some(row => !prior.exclusions?.some(old => canonical(old) === canonical(row)));
                const redactedThrough = newExclusion ? (await options.runtime.historyPage({ branchId: run.branch_id, limit: 1 }, signal)).head ?? undefined : prior.redactedThrough;
                const botKnowledge: BotKnowledgeState = { botId: botId!, threadId: run.thread_id, items: [...items.values()], invalidations: [...invalidations.values()], corrections: [...corrections.values()], exclusions,
                    ...(redactedThrough ? { redactedThrough } : {}) };
                const oldRevision = typeof previous.revision === 'number' ? previous.revision : 0;
                const revision = canonical(botKnowledge) === canonical(prior) ? oldRevision : oldRevision + 1;
                signal.throwIfAborted();
                return { status: 'ready', context, state: { revision, memories: [], noteRevisions: {}, botKnowledge } };
            }
            const args = record(query.arguments);
            const sources = args.sources === undefined ? undefined : Array.isArray(args.sources)
                ? args.sources.map(value => { const source = record(value); if (typeof source.itemId !== 'string' || typeof source.quote !== 'string') return invalid('Invalid memory source passage'); return { itemId: source.itemId, quote: source.quote }; })
                : invalid('sources must be an array');
            const derivedFrom = args.derivedFrom === undefined ? undefined : Array.isArray(args.derivedFrom)
                ? args.derivedFrom.map(value => { const source = record(value); if (!Number.isSafeInteger(source.id) || Number(source.id) <= 0 || typeof source.revision !== 'string') return invalid('Invalid supporting memory'); return { id: Number(source.id), revision: source.revision }; })
                : invalid('derivedFrom must be an array');
            const action = args.action;
            if (!['get', 'search', 'recall', 'remember', 'correct', 'forget', 'archive', 'rewrite', 'organize', 'maintenance_status', 'maintenance_cancel'].includes(String(action)))
                invalid('Unknown Bot memory action');
            if (args.scope !== undefined && args.scope !== 'bot' && args.scope !== 'user' && args.scope !== 'session')
                invalid('Bot memory scope must be bot, user or session');
            const owner: MemoryOwner = args.scope === 'user' ? { scope: 'user', ownerId: null } : args.scope === 'session' ? { scope: 'session', ownerId: run.thread_id } : { scope: 'bot', ownerId: botId! };
            if (action === 'maintenance_status') {
                if (!options.organizer) invalid('Memory maintenance is unavailable');
                return { status: 'ready', jobs: await options.organizer!.maintenanceStatus(botScopeId(botId!), typeof args.key === 'string' ? args.key : undefined, owner) };
            }
            const id = args.id;
            if (['get', 'correct', 'forget', 'archive'].includes(String(action)) && (!Number.isSafeInteger(id) || (id as number) <= 0))
                invalid('Memory id must be a positive integer');
            if (action === 'get') {
                const result = await options.memory.get(owner, id as number);
                if (result.item.forgottenAt !== undefined) invalid('This memory has been forgotten');
                return { status: 'ready', item: result.item, revision: sourceRevision(JSON.stringify([result.item.content, result.item.trigger, result.item.createdAt])),
                    chain: result.chain && { ...result.chain, predecessors: result.chain.predecessors.filter(row => row.forgottenAt === undefined),
                        successors: result.chain.successors.filter(row => row.forgottenAt === undefined), chain: result.chain.chain.filter(row => row.forgottenAt === undefined) },
                    ...(args.includeSource ? { sources: await options.memory.readSource(owner, id as number, botId!) } : {}) };
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
            if ((action === 'correct' || action === 'forget' || action === 'archive') && (!expected || typeof expected.content !== 'string' || typeof expected.trigger !== 'string'
                || !['suggested', 'accepted', 'dismissed'].includes(expected.status ?? '') || !(expected.invalidAt === null || typeof expected.invalidAt === 'number')))
                invalid('Read the row first and supply its exact expected values');
            if (action === 'organize' || action === 'maintenance_cancel') {
                if (!options.organizer) invalid('Memory organization is unavailable');
                if (action === 'organize') {
                    if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.some(id => !Number.isSafeInteger(id) || id <= 0))) invalid('ids must name existing memories');
                    const job = await options.organizer!.maintain(botScopeId(botId!), (args.ids ?? []) as number[], typeof args.reason === 'string' ? args.reason : 'Organize related understanding', origin.id, typeof args.query === 'string' ? args.query : undefined, owner);
                    mutationStarted = true;
                    await options.memory.maintain(owner, { inputs: [], retire: [], outputs: [], reason: `Background maintenance: ${job.key}` }, origin);
                    return { status: 'ready', job, memoryReceipt: await options.memory.mutationReceipt(owner, origin) };
                }
                if (typeof args.key !== 'string') invalid('Specify the original maintenance key');
                await options.organizer!.cancelMaintenance(botScopeId(botId!), args.key as string, owner);
                mutationStarted = true;
                await options.memory.maintain(owner, { inputs: [], retire: [], outputs: [], reason: `Cancel maintenance: ${args.key}` }, origin);
            }
            else if (action === 'rewrite') {
                if (!Array.isArray(args.inputs) || !Array.isArray(args.retire) || !Array.isArray(args.outputs)) invalid('rewrite requires inputs, retire and outputs');
                const inputs = await Promise.all((args.inputs as unknown[]).map(async raw => {
                    const ref = record(raw);
                    if (!Number.isSafeInteger(ref.id) || typeof ref.revision !== 'string') return invalid('Read exact input revisions with get');
                    const { item } = await options.memory.get(owner, Number(ref.id));
                    if (item.forgottenAt !== undefined || memoryVersion(item) !== ref.revision) return invalid('A rewrite input has changed');
                    return { id: item.id, expected: memoryExpected(item) };
                }));
                const outputs = (args.outputs as unknown[]).map(raw => {
                    const row = record(raw);
                    if (typeof row.content !== 'string' || !row.content.trim() || !Array.isArray(row.sources) || row.sources.some(id => !Number.isSafeInteger(id))) return invalid('Output accounts require content and input source IDs');
                    return { content: row.content, sources: row.sources as number[], ...(typeof row.trigger === 'string' ? { trigger: row.trigger } : {}), ...(row.overview === true ? { overview: true } : {}) };
                });
                signal.throwIfAborted(); mutationStarted = true;
                await options.memory.maintain(owner, { inputs, retire: args.retire as number[], outputs, reason: typeof args.reason === 'string' ? args.reason : 'Explicit memory rewrite' }, origin);
            }
            else if (action === 'forget' || action === 'archive') {
                mutationStarted = true;
                await options.memory[action](owner, id as number, expected, origin);
            }
            else {
                if (typeof args.content !== 'string' || !args.content.trim())
                    invalid('Memory content is required');
                const content = args.content as string;
                const exclusions=(await Promise.all(([owner,{scope:'user',ownerId:null}] as MemoryOwner[]).map(scope=>options.memory.exclusions(scope)))).flatMap(row=>row).flatMap(row=>row.source?.spans??[]);
                const quotes = sources ?? (derivedFrom?.length ? [] : [{ itemId: typeof args.sourceItemId === 'string' ? args.sourceItemId : '', quote: typeof args.sourceText === 'string' ? args.sourceText : content }]);
                const spans: MemorySourceSpan[] = [];
                let userSource = false;
                let head: string | undefined;
                for (const quote of quotes) {
                    let materials;
                    if (quote.itemId) {
                        head ??= (await options.runtime.historyPage({ branchId: identity.branchId, limit: 1 }, signal)).head ?? undefined;
                        if (!head) invalid('Original source history is unavailable');
                        materials = [await options.history.read(botId!, { kind: 'history-item', id: quote.itemId, threadId: run.thread_id,
                            branchId: run.branch_id, headId: head!, revision: '', start: 0, end: 1 }, signal)];
                    } else materials = await options.history.recent(identity, signal);
                    const source = materials.filter(item => item.text.includes(quote.quote)).at(-1);
                    if (!source || !quote.quote.trim()) invalid('Provide an exact supporting passage and sourceItemId when needed');
                    const start = source!.text.indexOf(quote.quote);
                    spans.push({ ...source!.span, start, end: start + quote.quote.length });
                    const selectedSpan=spans[spans.length-1]!;
                    if(exclusions.some(span=>overlappingSource(selectedSpan,source!.originalId===span.id?{...span,id:selectedSpan.id,threadId:selectedSpan.threadId}:span))) invalid('This original passage was forgotten; choose a currently permitted source');

                    userSource ||= source!.role === 'user';
                }
                for (const dependency of derivedFrom ?? []) {
                    const { item } = await options.memory.get(owner, dependency.id);
                    if (item.invalidAt !== undefined || dependency.revision !== sourceRevision(JSON.stringify([item.content, item.trigger, item.createdAt])))
                        invalid('A supporting memory has changed; read its current revision');
                    userSource ||= item.nature === 'instruction';
                }
                if (!spans.length && !derivedFrom?.length) invalid('Memory requires a supporting source');
                if (args.nature === 'instruction' && !userSource) invalid('Only user-sourced material can establish an instruction');
                const patch = { content, trigger: typeof args.trigger === 'string' ? args.trigger : '',
                    ...(args.nature ? { nature: args.nature as MemoryNature } : {}), source: { kind: 'agent-memory', threadId: run.thread_id, runId: run.id, spans,
                        ...(derivedFrom?.length ? { memories: derivedFrom } : {}) } };
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
