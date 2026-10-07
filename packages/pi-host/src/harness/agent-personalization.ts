import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, normalizeContext, type Context } from '@earendil-works/pi-ai';
import { convertToLlm, type AgentSession, type CompactionResult, type SessionEntry, type ToolResultEvent, type ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import { applyAgentMemorySnapshot, personalizeAgentSystemPrompt, renderAgentMemoryMutation, renderAgentSystemPrompt, splitAgentSystemPrompt,
  type AgentSystemPromptSnapshot, type AgentPersonalizationContext, type AgentMemorySnapshot,
  type AgentMemoryMutation, type AgentMemoryNote, type AgentMemoryChange } from '@varin/protocol';
import type { HostServicesBridge } from './host-services-bridge.js';
import type { ContextModelRequest, ContextRequestBoundaryOptions } from './context-request-boundary.js';

const SNAPSHOT = 'varin.agent-memory.snapshot';
const CHANGES = 'varin-memory';
const CHECKPOINT = 'agentMemorySnapshot';
const MUTATION = 'agentMemoryMutation';
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function snapshot(value: unknown): AgentMemorySnapshot | undefined {
  if (value === undefined) return undefined;
  const data = record(value);
  if (!data || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0
    || typeof data.sessionId !== 'string' || !Array.isArray(data.memories)
    || (data.projectId !== undefined && typeof data.projectId !== 'string')
    || data.memories.some(note => !record(note) || !Number.isSafeInteger(note.id) || note.id < 1
      || typeof note.content !== 'string' || typeof note.updatedAt !== 'string'
      || !record(note.scope) || !['global', 'project', 'session'].includes(note.scope.kind)
      || note.scope.kind !== 'global' && typeof note.scope.id !== 'string')) {
    throw new Error('The conversation memory checkpoint is malformed');
  }
  return data as unknown as AgentMemorySnapshot;
}

const capture = (context: AgentPersonalizationContext): AgentMemorySnapshot => structuredClone({
  revision: context.revision, sessionId: context.sessionId,
  ...(context.projectId ? { projectId: context.projectId } : {}), memories: context.memories,
});
const sameScope = (left: AgentMemorySnapshot, right: AgentPersonalizationContext) =>
  left.sessionId === right.sessionId && left.projectId === right.projectId;
const noteKey = (note: AgentMemoryNote) => JSON.stringify([note.scope, note.content]);

/** Read the active branch's checkpoint. Branch navigation never borrows another leaf's snapshot. */
function checkpoint(entries: SessionEntry[], context: AgentPersonalizationContext) {
  let found: { value: AgentMemorySnapshot; index: number } | undefined;
  for (const [index, entry] of entries.entries()) {
    const value = entry.type === 'custom' && entry.customType === SNAPSHOT ? snapshot(entry.data)
      : entry.type === 'compaction' ? snapshot(record(entry.details)?.[CHECKPOINT]) : undefined;
    if (value) found = sameScope(value, context) ? { value, index } : undefined;
  }
  return found;
}

function mutation(value: unknown): AgentMemoryMutation | undefined {
  if (value === undefined) return undefined;
  const data = record(value);
  if (!data || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Array.isArray(data.changes)
    || data.changes.some(change => !record(change) || !Number.isSafeInteger(change.id) || change.id < 1
      || change.note !== null && (!record(change.note) || change.note.id !== change.id
        || typeof change.note.content !== 'string' || !record(change.note.scope)))) {
    throw new Error('The conversation memory change receipt is malformed');
  }
  return data as unknown as AgentMemoryMutation;
}

function receipts(details: unknown): AgentMemoryMutation[] {
  const data = record(details);
  const single = mutation(data?.[MUTATION]);
  const multiple = data?.agentMemoryMutations;
  if (multiple !== undefined && !Array.isArray(multiple)) throw new Error('The conversation memory receipts are malformed');
  return [...(single ? [single] : []), ...((multiple as unknown[] | undefined) ?? []).map(value => {
    const receipt = mutation(value);
    if (!receipt) throw new Error('The conversation memory receipt is missing');
    return receipt;
  })];
}

function pendingChanges(entries: SessionEntry[], baseline: { value: AgentMemorySnapshot; index: number }, current: AgentPersonalizationContext): AgentMemoryChange[] {
  const known = new Map(baseline.value.memories.map(note => [note.id, note]));
  const revisions = new Map<number, number>();
  for (const entry of entries.slice(baseline.index + 1)) {
    const delivered = entry.type === 'message' && entry.message.role === 'toolResult'
      ? receipts(entry.message.details)
      : entry.type === 'custom_message' && entry.customType === CHANGES ? receipts(entry.details) : [];
    for (const receipt of delivered) {
      if (receipt.revision <= baseline.value.revision) continue;
      // Parallel tools can return in call order rather than memory commit order.
      for (const change of receipt.changes) if (receipt.revision > (revisions.get(change.id) ?? baseline.value.revision)) {
        revisions.set(change.id, receipt.revision);
        if (change.note) known.set(change.id, change.note); else known.delete(change.id);
      }
    }
  }
  const latest = new Map(current.memories.map(note => [note.id, note]));
  const changes: AgentMemoryChange[] = [];
  for (const note of current.memories) if (!known.has(note.id) || noteKey(known.get(note.id)!) !== noteKey(note)) changes.push({ id: note.id, note });
  for (const id of known.keys()) if (!latest.has(id)) changes.push({ id, note: null });
  return changes;
}

function withSections(context: Context, sections: Record<string, string>): Context {
  const normalized = normalizeContext(context);
  const current = getCurrentSystemMessage(normalized.messages);
  return { messages: [{ role: 'system', content: '',
    sections: Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, renderAgentSystemPrompt({ [name]: value })])),
    toolsAdded: getCurrentTools(normalized.messages), timestamp: current?.timestamp ?? 0 },
  ...normalized.messages.filter(message => message.role !== 'system')] };
}

export function createAgentPromptRuntime(bridge: HostServicesBridge, available: () => boolean = () => true) {
  let lastRequest: AgentSystemPromptSnapshot['lastRequest'];
  const nestedReceipts = new Map<string, AgentMemoryMutation[]>();
  const preferences = async (sessionId: string, signal?: AbortSignal): Promise<AgentPersonalizationContext> => {
    const empty: AgentPersonalizationContext = { mode: 'agent', revision: 0, threadRole: 'main', sessionId, profiles: [], memories: [] };
    if (!available()) return empty;
    const result = await bridge.request('session.instructions', {}, signal ? { signal } : {});
    return result.personalization ?? empty;
  };
  const ensureCheckpoint = (session: AgentSession, context: AgentPersonalizationContext) => {
    let branch = session.sessionManager.getBranch();
    let baseline = checkpoint(branch, context);
    if (!baseline) {
      const value = capture(context);
      // This records the chosen input snapshot, without changing the memory store.
      session.sessionManager.appendCustomEntry(SNAPSHOT, value);
      branch = session.sessionManager.getBranch();
      baseline = { value, index: branch.length - 1 };
    }
    return { branch, baseline };
  };
  return {
    preferences,
    memorySections(session: AgentSession, context: AgentPersonalizationContext): Record<string, string> {
      if (!available() || context.mode === 'bot') return {};
      return applyAgentMemorySnapshot({}, ensureCheckpoint(session, context).baseline.value);
    },
    toolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
      const saved = [...(nestedReceipts.get(event.toolCallId) ?? []), ...receipts(event.details)];
      nestedReceipts.delete(event.toolCallId);
      if (!saved.length) return;
      if (event.parentToolCallId) nestedReceipts.set(event.parentToolCallId,
        [...(nestedReceipts.get(event.parentToolCallId) ?? []), ...saved]);
      if (event.toolName === 'memory') return;
      const text = event.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const missing = saved.map(renderAgentMemoryMutation).filter(content => !text.includes(content));
      return { content: [...event.content, ...missing.map(content => ({ type: 'text' as const, text: content }))],
        ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
        details: { ...record(event.details), agentMemoryMutations: saved } };
    },
    clearToolReceipts() { nestedReceipts.clear(); },
    async inspect(session: AgentSession, selected?: AgentPersonalizationContext): Promise<AgentSystemPromptSnapshot> {
      const personalization = selected ?? await preferences(session.sessionId);
      const original = splitAgentSystemPrompt(session.systemPrompt);
      const branch = session.sessionManager.getBranch();
      const baseline = personalization.mode === 'agent' ? checkpoint(branch, personalization) : undefined;
      const memorySnapshot = baseline?.value ?? capture(personalization);
      const sections = personalizeAgentSystemPrompt(original, { ...personalization, ...memorySnapshot });
      return { sessionId: session.sessionId, mode: personalization.mode, original, sections,
        content: renderAgentSystemPrompt(sections), personalization,
        ...(personalization.mode === 'agent' ? { memorySnapshot,
          pendingMemoryChanges: baseline ? pendingChanges([], { ...baseline, index: -1 }, personalization) : [] } : {}),
        ...(lastRequest ? { lastRequest } : {}) };
    },
    async inject(request: ContextModelRequest, session: AgentSession): Promise<Awaited<ReturnType<NonNullable<ContextRequestBoundaryOptions['inject']>>>> {
      if (!available()) return { request };
      const personalization = await preferences(session.sessionId, request.options.signal);
      if (personalization.mode === 'bot') return { request };
      const { branch, baseline } = ensureCheckpoint(session, personalization);
      const sections = personalizeAgentSystemPrompt(splitAgentSystemPrompt(getCurrentSystemPrompt(normalizeContext(request.context).messages) || session.systemPrompt),
        { ...personalization, ...baseline.value });
      const context = withSections(request.context, sections);
      const changes = pendingChanges(branch, baseline, personalization);
      if (!changes.length) return { request: { ...request, context } };
      const receipt: AgentMemoryMutation = { revision: personalization.revision, changes };
      const content = renderAgentMemoryMutation(receipt);
      context.messages.push({ role: 'user', content: [{ type: 'text', text: content }], timestamp: Date.now() });
      return { request: { ...request, context }, retained: [{ customType: CHANGES, content, details: { [MUTATION]: receipt } }] };
    },
    async prepareCompaction(result: CompactionResult, session: AgentSession, signal: AbortSignal, request?: ContextModelRequest): Promise<CompactionResult> {
      if (!available()) return result;
      const personalization = await preferences(session.sessionId, signal);
      if (personalization.mode === 'bot') return result;
      const value = capture(personalization);
      const source = request?.context ?? { messages: convertToLlm(session.sessionManager.buildSessionContext().messages) };
      const sections = personalizeAgentSystemPrompt(splitAgentSystemPrompt(getCurrentSystemPrompt(normalizeContext(source).messages) || session.systemPrompt),
        { ...personalization, ...value });
      const systemMessage = getCurrentSystemMessage(withSections(source, sections).messages)!;
      return { ...result, systemMessage, details: { ...record(result.details), [CHECKPOINT]: value } };
    },
    sent(request: ContextModelRequest) {
      lastRequest = { content: getCurrentSystemPrompt(normalizeContext(request.context).messages), timestamp: Date.now() };
    },
  };
}
