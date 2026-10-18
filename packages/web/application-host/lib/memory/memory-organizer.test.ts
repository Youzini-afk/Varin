import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openKnowledgeStoreEngine } from "../knowledge/store-engine.js";
import type { KnowledgeScope, KnowledgeStore } from "../knowledge/store-contract.js";
import { createMemoryService, type MemoryOwner, type MemoryService } from "./memory-service.js";
import { createMemoryOrganizer } from "./memory-organizer.js";
import { memorySourceClaims, type MemoryInference, type MemoryInferenceBinding, type MemoryWork } from "./memory-inference.js";
import type { HistoryMemoryMaterial } from "./bot-history.js";
import { sourceRevision } from "./memory-sources.js";

let testDir: string;

let counter = 0;
const openStore = async (scope: KnowledgeScope = "bot", name = `store-${++counter}`): Promise<KnowledgeStore> => {
  const dir = join(testDir, name.replaceAll(":", "_"));
  mkdirSync(dir, { recursive: true });
  return openKnowledgeStoreEngine({ dataDir: dir, hostId: "test-host", workspaceId: name.replaceAll(":", "_"), scope, embedding: null });
};

const scopeOfStoreId = (scopeId: string): KnowledgeScope => (
  scopeId.startsWith("bot:") ? "bot" : scopeId.startsWith("thread:") ? "session" : "bot"
);

interface StubCall { method: string; params: Record<string, unknown> }

const wait = async (predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await vi.advanceTimersToNextTimerAsync();
    await setImmediate();
  }
  throw new Error("timed out waiting for organizer");
};

describe("memory organizer (BC2)", () => {
  let stores: Map<string, KnowledgeStore>;
  let userStore: KnowledgeStore;
  let calls: StubCall[];
  let organizeText: string | (() => string | Promise<string>);
  let inferenceWorks: Map<string, MemoryWork>;
  let generations: Map<string, Promise<string>>;
  let nowMs: number;
  let materials: HistoryMemoryMaterial[];
  let autoOrganize: { user: boolean; bot: boolean };
  let contextWindow: number | null;
  let organizerConfigured: boolean;
  let organizers: Set<ReturnType<typeof createMemoryOrganizer>>;
  let releaseInference: Array<() => void>;

  const memory = (overrides: Partial<Parameters<typeof createMemoryService>[0]> = {}): MemoryService => createMemoryService({
    storeForScopeId: async (scopeId) => {
      const existing = stores.get(scopeId);
      if (existing) return existing;
      const opened = await openStore(scopeOfStoreId(scopeId));
      stores.set(scopeId, opened);
      return opened;
    },
    userStore: async () => userStore,
    ownerForThread: async (sessionId) => ({ scope: "bot", ownerId: sessionId }),
    ...overrides,
  });

  // This seam supplies retained inference results only. MemoryService and the
  // TriviumDB KnowledgeStore remain real; no native transport/kernel claim is made.
  // Keep work and original output across organizer instances for recovery tests.
  const inference = (): MemoryInference => {
    const active = new Map<string, AbortController>();
    return {
      async settings() {
        calls.push({ method: "settings", params: {} });
        return { harness: {
          ...(organizerConfigured ? { models: { memoryOrganizer: { providerId: "test-provider", modelId: "test-model" } } } : {}),
          knowledge: { autoOrganize },
        } };
      },
      async model(selection) {
        return { ...selection, name: selection.modelId, api: "openai-completions", baseUrl: "https://inference.invalid",
          input: ["text"], ...(contextWindow === null ? {} : { contextWindow }), maxTokens: 4_096 };
      },
      async describeDecision() { return { status: "unconfigured" }; },
      async bind(selection, maxOutputTokens) {
        calls.push({ method: "bind", params: { ...selection, maxOutputTokens } });
        return {
          configuration: { providerId: selection.providerId, providerFamily: "openai", model: selection.modelId,
            endpoint: "https://inference.invalid", credentialEnvironment: null, allowAnonymous: true,
            configurationGeneration: 1, maxOutputTokens: maxOutputTokens ?? null },
          credentialScope: { reference: "test", authority: "test", account: "test", generation: 1 },
        };
      },
      async admit<R extends { binding: MemoryInferenceBinding }>(input: {
        key: string; scopeId: string; mode: "automatic" | "selection";
        spans: Parameters<MemoryInference["admit"]>[0]["spans"]; recipe: R; retryOf?: string;
      }): Promise<MemoryWork<R>> {
        const workId = `memory-work:${input.key}`;
        const existing = inferenceWorks.get(workId);
        if (existing) return existing as MemoryWork<R>;
        const work: MemoryWork<R> = {
          workId, scopeId: input.scopeId, mode: input.mode, runId: `run:${input.key}`, revision: 1,
          executionOwner: { kind: "external", identity: "test-memory-inference", epoch: "test" },
          cancelled: false, consumed: false, consumerFailed: false, claims: memorySourceClaims(input.spans),
          decision: null, inference: [], recipe: input.recipe,
        };
        inferenceWorks.set(workId, work);
        return work;
      },
      async find<R>(key: string) { return (inferenceWorks.get(`memory-work:${key}`) as MemoryWork<R> | undefined) ?? null; },
      async read<R>(workId: string) {
        const work = inferenceWorks.get(workId);
        if (!work) throw new Error(`Unknown inference work: ${workId}`);
        return work as MemoryWork<R>;
      },
      async list<R>(scopeId: string) {
        return [...inferenceWorks.values()].filter(work => work.scopeId === scopeId && !work.consumed) as MemoryWork<R>[];
      },
      async decide(work, input) {
        work.decision ??= input.materials.map((_, index) => index);
        return work;
      },
      async generate(work, system, prompt, signal, assertSource) {
        let original = generations.get(work.workId);
        if (!original) {
          await assertSource?.();
          const controller = new AbortController();
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          const aborted = () => calls.push({ method: "generate.cancel", params: { workId: work.workId } });
          combined.addEventListener("abort", aborted, { once: true });
          active.set(work.workId, controller);
          calls.push({ method: "generate", params: { workId: work.workId, system, prompt,
            maxOutputTokens: work.recipe.binding.configuration.maxOutputTokens } });
          original = (async () => {
            try {
              const text = typeof organizeText === "function" ? await organizeText() : organizeText;
              combined.throwIfAborted();
              return text;
            } finally {
              active.delete(work.workId);
              combined.removeEventListener("abort", aborted);
            }
          })();
          generations.set(work.workId, original);
        }
        const text = await original;
        signal?.throwIfAborted();
        return { work, text };
      },
      async finish(work) { work.consumed = true; },
      async reject(work) { work.consumerFailed = true; },
      async suspendScope(scopeId) {
        for (const work of inferenceWorks.values()) if (work.scopeId === scopeId) active.get(work.workId)?.abort();
      },
      resumeScope() {},
      async close() { for (const controller of active.values()) controller.abort(); },
    };
  };

  const organizer = (service: MemoryService, overrides: Partial<Parameters<typeof createMemoryOrganizer>[0]> = {}) => {
    const owner = inference();
    const instance = createMemoryOrganizer({
    getInference: () => owner,
    storeForScopeId: async (scopeId) => {
      const existing = stores.get(scopeId);
      if (existing) return existing;
      const opened = await openStore(scopeOfStoreId(scopeId));
      stores.set(scopeId, opened);
      return opened;
    },
    hasStoreForScope: (scopeId) => stores.has(scopeId),
    listScopeIds: async () => [...stores.keys()],
    nativeMaterials: async () => materials,
    readNativeSource: async (_scope, span) => {
      const material = materials.find(item => item.span.id === span.id && item.span.threadId === span.threadId);
      if (!material) throw new Error('Original source is unavailable');
      return material.text;
    },
    scopeForThread: async () => 'bot:ws-1',
    memory: service,
    now: () => nowMs,
    onError: (error) => { console.error("[organizer]", error); },
    ...overrides,
    });
    organizers.add(instance);
    return instance;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    testDir = mkdtempSync(join(tmpdir(), 'varin-memory-organizer-'));
    organizers = new Set();
    releaseInference = [];
    stores = new Map();
    userStore = await openStore("user", "user-store");
    calls = [];
    organizeText = JSON.stringify({ memories: [] });
    inferenceWorks = new Map();
    generations = new Map();
    nowMs = 1_000_000;
    materials = [];
    autoOrganize = { user: true, bot: true };
    contextWindow = 200_000;
    organizerConfigured = true;
  });

  afterEach(async () => {
    try {
      for (const release of releaseInference) release();
      await Promise.all([...organizers].map(instance => instance.dispose()));
    } finally {
      try {
        await Promise.all([...new Set([...stores.values(), userStore])].map(store => store.close()));
      } finally {
        rmSync(testDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    }
  });

  const material = (id: string, text: string, witness = 'head'): HistoryMemoryMaterial => ({ role: 'user', text,
    span: { kind: 'history-item', id, threadId: 'thread:bot', branchId: 'branch:bot', headId: witness,
      revision: sourceRevision(text), start: 0, end: text.length } });
  const setup = async (text = 'Use PostgreSQL for the catalog.') => {
    const store = await openStore('bot', 'bot:ws-1'); stores.set('bot:ws-1', store);
    materials = [material('h1', text)];
    return store;
  };
  const proposal = (quote: string, content = quote) => JSON.stringify({ memories: [{ action: 'new', scope: 'bot', nature: 'decision', content, trigger: 'catalog', source: 'u0', quote }] });
  const owner: MemoryOwner = { scope: 'bot', ownerId: 'ws-1' };
  const settled = (store: KnowledgeStore) => wait(async () => (await store.listOrganizerProgress()).some(row => ['formed', 'reviewed-empty', 'failed'].includes(row.status)));

  it('discovers only Bot sources, without opening ordinary or user stores', async () => {
    const store = await setup(); const opened: string[] = [];
    const org = organizer(memory(), { listScopeIds: async () => ['user', 'thread:ordinary', 'project', 'bot:ws-1'],
      storeForScopeId: async scope => { opened.push(scope); return store; } });
    org.start(); await wait(() => calls.some(call => call.method === 'generate')); await settled(store);
    expect(new Set(opened)).toEqual(new Set(['bot:ws-1']));
  });
  it('commits source-bound proposals and does not reprocess coverage after reopening', async () => {
    const store = await setup(); organizeText = proposal(materials[0]!.text);
    let org = organizer(memory()); org.noteScope('bot:ws-1'); await settled(store); await org.dispose();
    const [item] = await store.listKnowledge({ scope: 'bot' });
    expect(item).toMatchObject({ status: 'accepted', nature: 'decision', source: { kind: 'memory-organizer', threadId: 'thread:bot', spans: [{ kind: 'history-item', id: 'h1' }] } });
    // Read witnesses may change, but original immutable item coverage does not.
    materials = [material('h1', materials[0]!.text, 'later-head')];
    org = organizer(memory()); org.noteScope('bot:ws-1'); await wait(() => org.pending === 0);
    expect(calls.filter(call => call.method === 'generate')).toHaveLength(1);
  });
  it('preserves explicit forgotten coverage while organizing unrelated original text', async () => {
    const store = await setup('Use SQLite. Backups run Thursday.'); const service = memory();
    const saved = await service.remember(owner, { content: 'Use SQLite.', source: { kind: 'memory.remember', threadId: 'thread:bot', spans: [{ ...materials[0]!.span, end: 11 }] } });
    await service.forget(owner, saved.item.id);
    const org = organizer(service); org.noteScope('bot:ws-1'); await settled(store);
    const prompt = String(calls.find(call => call.method === 'generate')!.params.prompt);
    expect(prompt).not.toContain('Use SQLite.'); expect(prompt).toContain('Backups run Thursday.');
  });
  it('retains a failed original generation instead of retrying it with a new paid request', async () => {
    const store = await setup(); organizeText = () => { throw new Error('Original provider outcome unknown'); };
    const org = organizer(memory()); org.noteScope('bot:ws-1'); await settled(store);
    nowMs += 600_000; org.retryScope('bot:ws-1'); await wait(() => org.pending === 0);
    expect(calls.filter(call => call.method === 'generate')).toHaveLength(1);
    expect(await store.listKnowledge({})).toEqual([]);
  });
  it('does not publish stale proposals after a human memory change during generation', async () => {
    const store = await setup(); const service = memory();
    organizeText = async () => { await service.remember(owner, { content: 'Human correction wins.' }); return proposal(materials[0]!.text); };
    const org = organizer(service); org.noteScope('bot:ws-1'); await wait(() => calls.some(call => call.method === 'generate')); await wait(() => org.pending === 0);
    expect((await store.listKnowledge({})).map(item => item.content)).toEqual(['Human correction wins.']);
    expect((await store.listOrganizerProgress()).some(row => row.status === 'prepared' && row.lastError?.includes('Memory changed'))).toBe(true);
  });
  it('commits distinct proposals from one original source without self-conflicting', async () => {
    const store = await setup('Use PostgreSQL. Backups run Thursday.');
    organizeText = JSON.stringify({ memories: [JSON.parse(proposal('Use PostgreSQL.')).memories[0], JSON.parse(proposal('Backups run Thursday.')).memories[0]] });
    const org = organizer(memory()); org.noteScope('bot:ws-1'); await settled(store);
    expect(await store.listKnowledge({ scope: 'bot' })).toHaveLength(2);
    expect((await store.listOrganizerProgress())[0]?.produced).toHaveLength(2);
  });
  it('extracts an explicit native selection while automatic organization is disabled', async () => {
    await setup(); autoOrganize = { user: false, bot: false };
    organizeText = JSON.stringify({ memories: [{ content: materials[0]!.text, trigger: '', nature: 'instruction', source: 's0', quote: materials[0]!.text }] });
    const org = organizer(memory()); const span = materials[0]!.span;
    const text = await org.extractSelection('bot:ws-1', 'extract', JSON.stringify({ passages: [{ role: 'user', text: materials[0]!.text }] }), new AbortController().signal,
      { requestKey: 'selection', conversation: { runtime: 'agent', threadId: span.threadId, branchId: span.branchId, headId: span.headId }, sources: [span] });
    expect(text).toContain('PostgreSQL'); expect(await memory().list(owner)).toEqual([]);
  });
});
