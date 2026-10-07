import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { SessionManager, convertToLlm, type AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, normalizeContext, type Context, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMemoryNote, AgentPersonalizationContext, AgentMemoryMutation, JsonValue } from '@varin/protocol';
import { createAgentPromptRuntime } from '../../src/harness/agent-personalization.js';
import { attachContextRequestBoundary } from '../../src/harness/context-request-boundary.js';
import type { HostServicesBridge } from '../../src/harness/host-services-bridge.js';

const MODEL = { provider: 'faux', id: 'memory-test', api: 'openai-completions', contextWindow: 100_000, maxTokens: 100 } as Model<Api>;
const note = (content: string, id = 1): AgentMemoryNote => ({ id, content, scope: { kind: 'project', id: 'p' }, updatedAt: '2026-10-07' });
const reply = (failed = false): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'done' }],
  api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1, stopReason: failed ? 'error' : 'stop',
  usage: { input: 100, output: 1, totalTokens: 101, cacheRead: 0, cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

function harness(manager = SessionManager.inMemory('/workspace')) {
  let current: AgentPersonalizationContext = { mode: 'agent', threadRole: 'main', revision: 1,
    sessionId: manager.getSessionId(), projectId: 'p', profiles: [], memories: [note('Use PostgreSQL.')] };
  const outgoing: Context[] = [];
  let fail = false;
  let compact = false;
  let rejectCheckpoint = false;
  let kept = '';
  let checkpointUpdate: { memories: AgentMemoryNote[]; revision: number } | undefined;
  const bridge = { request: async () => ({ instructions: null, personalization: structuredClone(current) }) } as unknown as HostServicesBridge;
  const runtime = createAgentPromptRuntime(bridge);
  const bound = { model: MODEL, sessionId: manager.getSessionId(), sessionManager: manager, systemPrompt: 'Stable instructions.',
    refreshContext: () => {}, cancelCacheWarming: () => {},
    agent: { state: { tools: [], thinkingLevel: 'off' }, convertToLlm, streamFunction: async (_model: unknown, context: Context) => {
      outgoing.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      if (fail) stream.push({ type: 'error', reason: 'error', error: reply(true) });
      else { stream.push({ type: 'start', partial: reply() }); stream.push({ type: 'done', reason: 'stop', message: reply() }); }
      return stream;
    } },
  } as unknown as AgentSession;
  const boundary = attachContextRequestBoundary(bound, {
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
    hasImmediateCompaction: () => compact,
    observe: () => {}, inject: (request, session) => runtime.inject(request, session),
    compact: async (request, signal) => {
      if (checkpointUpdate) { current = { ...current, ...checkpointUpdate }; checkpointUpdate = undefined; }
      const result = await runtime.prepareCompaction({ summary: 'Earlier work.', firstKeptEntryId: kept, tokensBefore: 500 }, bound, signal, request);
      if (rejectCheckpoint) throw new Error('Compaction cancelled before publication');
      compact = false; return result;
    },
  });
  return { manager, runtime, outgoing, bound,
    update(memories: AgentMemoryNote[], revision: number) { current = { ...current, memories, revision }; },
    fail(value: boolean) { fail = value; },
    compact(cancel = false) { compact = true; rejectCheckpoint = cancel; },
    updateDuringCompaction(memories: AgentMemoryNote[], revision: number) { checkpointUpdate = { memories, revision }; },
    async run(text = 'continue') {
      if (!manager.getBranch().length) manager.appendMessage({ role: 'system', content: 'Stable instructions.', timestamp: 0 });
      kept = manager.appendMessage({ role: 'user', content: text, timestamp: 1 });
      const stream = await bound.agent.streamFunction(MODEL, normalizeContext({ messages: convertToLlm(manager.buildSessionContext().messages) }), {});
      const result = await stream.result();
      if (result.stopReason !== 'error') manager.appendMessage(result);
      return result;
    },
    dispose: boundary.dispose,
  };
}
const system = (context: Context) => getCurrentSystemPrompt(context.messages);
const tail = (context: Context) => JSON.stringify(context.messages.filter(message => message.role !== 'system'));

it('keeps the prefix stable while delivering external updates/deletions once, and retries undelivered changes', async () => {
  const h = harness();
  try {
    await h.run();
    const prefix = system(h.outgoing[0]!);
    h.update([note('Use SQLite.')], 2);
    h.fail(true); await h.run();
    assert.equal(system(h.outgoing[1]!), prefix);
    assert.match(tail(h.outgoing[1]!), /Use SQLite/);
    assert.equal(h.manager.getBranch().filter(entry => entry.type === 'custom_message').length, 0);
    h.fail(false); await h.run(); await h.run();
    assert.equal(system(h.outgoing[3]!), prefix);
    assert.equal(h.manager.getBranch().filter(entry => entry.type === 'custom_message').length, 1);
    assert.equal(h.outgoing[3]!.messages.filter(message => JSON.stringify(message).includes('Use SQLite.')).length, 1);
    h.update([], 3); await h.run();
    assert.equal(system(h.outgoing[4]!), prefix);
    assert.match(tail(h.outgoing[4]!), /\[1\] deleted/);
    h.compact(); await h.run();
    assert.doesNotMatch(system(h.outgoing[5]!), /Use PostgreSQL|agent_memory_/);
  } finally { h.dispose(); }
});

it('uses direct and nested memory tool receipts without another memory-change message', async () => {
  const h = harness();
  try {
    await h.run(); const prefix = system(h.outgoing[0]!);
    const saved: AgentMemoryMutation = { revision: 2, changes: [{ id: 2, note: note('Project builds with Bun.', 2) }] };
    h.update([note('Use PostgreSQL.'), note('Project builds with Bun.', 2)], 2);
    h.manager.appendMessage({ role: 'toolResult', toolCallId: 'memory-call', toolName: 'memory',
      content: [{ type: 'text', text: 'Saved project note.' }], details: { agentMemoryMutation: saved } as unknown as JsonValue, isError: false, timestamp: 1 });
    await h.run();
    assert.equal(system(h.outgoing[1]!), prefix);
    assert.equal(h.manager.getBranch().filter(entry => entry.type === 'custom_message').length, 0);
    const corrected: AgentMemoryMutation = { revision: 3, changes: [{ id: 1, note: note('Use SQLite.') }] };
    h.update([note('Use SQLite.'), note('Project builds with Bun.', 2)], 3);
    h.runtime.toolResult({ type: 'tool_result', toolName: 'memory', toolCallId: 'script/1', parentToolCallId: 'script',
      input: {}, content: [{ type: 'text', text: 'updated' }], details: { agentMemoryMutation: corrected }, isError: false });
    const result = h.runtime.toolResult({ type: 'tool_result', toolName: 'codemode', toolCallId: 'script',
      input: {}, content: [{ type: 'text', text: 'script finished' }], details: {}, isError: false })!;
    assert.match(JSON.stringify(result.content), /Use SQLite/);
    h.manager.appendMessage({ role: 'toolResult', toolCallId: 'script', toolName: 'codemode', content: result.content!,
      details: result.details as JsonValue, isError: false, timestamp: 1 });
    await h.run();
    assert.equal(system(h.outgoing[2]!), prefix);
    assert.equal(h.manager.getBranch().filter(entry => entry.type === 'custom_message').length, 0);
  } finally { h.dispose(); }
});

it('publishes a new memory snapshot with compaction, restores it from disk, and restores the old branch snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-memory-checkpoint-'));
  assert.ok(root.startsWith(join(tmpdir(), 'varin-memory-checkpoint-')));
  let h = harness(SessionManager.create(root, root));
  try {
    await h.run('Earlier task detail. '.repeat(250));
    const oldPrefix = system(h.outgoing[0]!);
    const oldLeaf = h.manager.getLeafId()!;
    h.update([note('Use SQLite.')], 2);
    h.compact(); await h.run();
    assert.match(system(h.outgoing[1]!), /Use SQLite/);
    assert.doesNotMatch(system(h.outgoing[1]!), /Use PostgreSQL/);
    const entry = h.manager.getBranch().findLast(entry => entry.type === 'compaction');
    assert.ok(entry && entry.type === 'compaction');
    assert.equal((entry.details as { agentMemorySnapshot: { revision: number } }).agentMemorySnapshot.revision, 2);
    assert.match(getCurrentSystemPrompt([entry.systemMessage!]), /Use SQLite/);
    assert.doesNotMatch(getCurrentSystemPrompt([entry.systemMessage!]), /Use PostgreSQL/);
    const file = h.manager.getSessionFile()!;
    h.dispose(); h = harness(SessionManager.open(file));
    h.update([note('Use DuckDB.')], 3); await h.run();
    assert.match(system(h.outgoing[0]!), /Use SQLite/);
    assert.doesNotMatch(system(h.outgoing[0]!), /Use DuckDB/);
    assert.match(tail(h.outgoing[0]!), /Use DuckDB/);
    h.manager.branch(oldLeaf); await h.run();
    assert.equal(system(h.outgoing[1]!), oldPrefix);
    assert.match(tail(h.outgoing[1]!), /Use DuckDB/);
  } finally { h.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('keeps the old snapshot when compaction fails and includes new snapshot bytes in precommit capacity validation', async () => {
  const h = harness();
  try {
    await h.run('Earlier task detail. '.repeat(150));
    const prefix = system(h.outgoing[0]!);
    h.update([note('Use SQLite.')], 2);
    h.compact(true); await assert.rejects(h.run(), /cancelled before publication/);
    assert.equal(h.manager.getBranch().some(entry => entry.type === 'compaction'), false);
    assert.match((await h.runtime.inspect(h.bound)).content, /Use PostgreSQL/);
    h.updateDuringCompaction([note('Very long persistent note. '.repeat(1000))], 3);
    h.compact(); await assert.rejects(h.run(), /does not free input capacity/);
    assert.equal(h.manager.getBranch().some(entry => entry.type === 'compaction'), false);
    assert.equal((await h.runtime.inspect(h.bound)).content, prefix);
  } finally { h.dispose(); }
});
