import { createRequire } from 'node:module';
import type { ComponentType, PropsWithChildren } from 'react';
import { parseHTML } from 'linkedom';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMemoryExtraction, ChatMemoryPassage } from '@varin/application-client';
import type { PiSessionEntry } from '@varin/protocol';
import { routerTransport } from '../extensions/direct-router.test-helper.js';
import type { KnowledgeStore } from '../knowledge/store-contract.js';
import { createMemoryService, type MemoryOwner } from './memory-service.js';
import type { AgentPersonalization } from './agent-personalization.js';
import { MemoryInferenceError } from './memory-inference.js';
import { sourceRevision } from './memory-sources.js';
import { registerSelectionMemoryRoutes } from './selection-memory-routes.js';

// React is a renderer dependency: resolve its installed runtime from the owning UI package.
const requireUI = createRequire(new URL('../../../../ui/package.json', import.meta.url));
const React: typeof import('react') = await import(requireUI.resolve('react'));
const { act } = React;
const { createRoot }: typeof import('react-dom/client') = await import(requireUI.resolve('react-dom/client'));

const browser = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<object>(),
  runtimeFetch: browser.fetch, getRuntimeKey: () => 'direct-runtime', subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, onOpenChange }: PropsWithChildren<{ onOpenChange(open: boolean): void }>) =>
    React.createElement('div', { role: 'dialog' }, children, React.createElement('button', { onClick: () => onOpenChange(false) }, 'Close')),
  DialogContent: ({ children }: PropsWithChildren) => React.createElement('div', null, children),
  DialogHeader: ({ children }: PropsWithChildren) => React.createElement('header', null, children),
  DialogTitle: ({ children }: PropsWithChildren) => React.createElement('h2', null, children),
}));

const sessionId = 'session-1';
const base = `https://host.invalid/api/harness/sessions/${sessionId}/knowledge/extracted`;
const original = 'Prefer concise updates. Unselected private context.';
const selected = 'Prefer concise updates.';
const sources = [{ entryId: 'entry-1', start: 0, text: selected }];
const entry: PiSessionEntry = { id: 'entry-1', parentId: null, type: 'message', timestamp: 'now',
  message: { role: 'user', timestamp: 1, content: original } };
const generated = JSON.stringify({ memories: [{ content: 'Give concise updates.', trigger: 'Progress reporting',
  nature: 'preference', source: 's0', quote: selected }] });
type Narrate = Parameters<typeof registerSelectionMemoryRoutes>[1]['narrate'];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(agentPersonalization?: AgentPersonalization) {
  const state = { owner: { scope: 'bot', ownerId: 'bot-1' } as MemoryOwner, entries: [entry] };
  const write = vi.fn<KnowledgeStore['createKnowledgeIfAbsent']>();
  const store = { createKnowledgeIfAbsent: write } as unknown as KnowledgeStore;
  const memory = createMemoryService({ ownerForSession: async () => state.owner,
    storeForScopeId: async () => store, userStore: async () => store, readSessionEntries: async () => state.entries });
  const narrate = vi.fn<Narrate>().mockResolvedValue(generated);
  const router = express.Router();
  const requireAuth = vi.fn<Parameters<typeof registerSelectionMemoryRoutes>[1]['requireAuth']>((request, response, next) =>
    request.headers['x-varin-application-token'] === 'ui-token' ? next() : response.status(401).json({ error: 'Authentication required' }));
  registerSelectionMemoryRoutes(router as unknown as Express, { memory, ...(agentPersonalization ? { agentPersonalization } : {}), narrate,
    entries: async () => state.entries, requireAuth });
  const transport = routerTransport(router);
  const post = (body: unknown, options: { auth?: boolean; signal?: AbortSignal; path?: string } = {}) =>
    transport(new URL(options.path ?? `${base}/preview`), { method: 'POST',
      headers: options.auth === false ? {} : { 'x-varin-application-token': 'ui-token' },
      body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) });
  return { state, write, narrate, requireAuth, transport, post };
}

afterEach(() => { vi.unstubAllGlobals(); browser.fetch.mockReset(); });

describe('selected memory authenticated direct Router', () => {
  it('projects the request identity and only Host-validated source ranges to the inference owner', async () => {
    const { post, narrate, write, requireAuth } = fixture();
    const body = { sources, requestKey: 'selected-1', owner: { scope: 'user', ownerId: null },
      model: 'renderer-model', credentialScope: 'renderer-secret', sessionId: 'another-session' };
    expect((await post(body, { auth: false })).status).toBe(401);
    expect(narrate).not.toHaveBeenCalled();
    const result = await post(body);
    expect(result.status).toBe(200);
    const preview = await result.json() as ChatMemoryExtraction & { requestKey: string };
    expect(preview).toMatchObject({ requestKey: 'selected-1', owner: { scope: 'bot', ownerId: 'bot-1' }, drafts: [{ content: 'Give concise updates.' }] });
    expect(requireAuth).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(narrate).toHaveBeenCalledTimes(1);
    const [scope, system, prompt, signal, selection] = narrate.mock.calls[0]!;
    expect(scope).toBe('bot:bot-1');
    expect(system).toContain('selected');
    expect(JSON.parse(prompt)).toEqual({ passages: [{ id: 's0', role: 'user', text: selected }] });
    expect(signal.aborted).toBe(false);
    expect(selection).toEqual({ requestKey: 'selected-1', sessionId, sources: [{ kind: 'pi-entry', id: 'entry-1',
      sessionId, revision: sourceRevision(original), start: 0, end: selected.length }] });
    expect(preview.drafts[0]!.sources[0]!.revision).toBe(selection.sources[0]!.revision);
  });

  it('passes observation and explicit retry identities unchanged instead of deduplicating in the route', async () => {
    const { post, narrate } = fixture();
    await post({ sources, requestKey: 'selected-1' });
    await post({ sources, requestKey: 'selected-1' });
    await post({ sources, requestKey: 'selected-2', retryOf: 'selected-1' });
    expect(narrate.mock.calls.map(call => ({ requestKey: call[4].requestKey, retryOf: call[4].retryOf }))).toEqual([
      { requestKey: 'selected-1', retryOf: undefined }, { requestKey: 'selected-1', retryOf: undefined },
      { requestKey: 'selected-2', retryOf: 'selected-1' },
    ]);
  });

  it('projects typed owner retry dispositions without using code-name or status heuristics', async () => {
    const { post, narrate } = fixture();
    for (const retryDisposition of ['observe', 'new_attempt', 'none'] as const) {
      narrate.mockRejectedValueOnce(new MemoryInferenceError('same-code', 'Owner result', retryDisposition));
      const result = await post({ sources, requestKey: 'selected-1' });
      expect(await result.json()).toEqual({ error: 'Owner result', code: 'same-code', requestKey: 'selected-1', retryDisposition });
    }
    narrate.mockRejectedValueOnce(Object.assign(new Error('Unknown service failure'), { retryDisposition: 'invented', code: 42 }));
    expect(await (await post({ sources, requestKey: 'selected-1' })).json()).toEqual({
      error: 'Unknown service failure', requestKey: 'selected-1', retryDisposition: 'observe',
    });
    narrate.mockResolvedValueOnce('not valid JSON');
    expect(await (await post({ sources, requestKey: 'selected-1' })).json()).toMatchObject({ requestKey: 'selected-1', retryDisposition: 'observe' });
  });

  it('rejects invalid identities, changed sources and invalid owners before inference without changing their scope', async () => {
    const { post, narrate, state } = fixture();
    expect(await (await post({ sources })).json()).toMatchObject({ requestKey: null, retryDisposition: 'none' });
    expect((await post({ sources, requestKey: 'selected-1', retryOf: 'selected-1' })).status).toBe(400);
    const changed = await post({ requestKey: 'selected-1', sources: [{ ...sources[0], text: 'fabricated' }] });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ requestKey: 'selected-1', retryDisposition: 'none' });
    state.owner = { scope: 'bot', ownerId: null };
    expect((await post({ sources, requestKey: 'selected-1' })).status).toBe(400);
    expect(narrate).not.toHaveBeenCalled();
  });

  it('keeps ordinary Agent selection as editable local drafts without any model call or save', async () => {
    const context = vi.fn().mockResolvedValue({ mode: 'agent', projectId: 'project-1' });
    const { post, narrate, write } = fixture({ context } as unknown as AgentPersonalization);
    const result = await post({ sources, requestKey: 'agent-selection' });
    expect(await result.json()).toEqual({ requestKey: 'agent-selection', owner: { scope: 'workspace', ownerId: 'project-1' },
      drafts: [{ content: selected, trigger: '', nature: 'instruction',
        sources: [{ ...sources[0], revision: sourceRevision(original) }] }] });
    expect(narrate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('propagates a disconnected observer to the original inference signal without writing memory', async () => {
    const { post, narrate, write, transport } = fixture();
    const entered = deferred(), drained = deferred();
    narrate.mockImplementationOnce(async (_scope, _system, _prompt, signal) => {
      entered.resolve();
      try { return await new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
      finally { drained.resolve(); }
    });
    const controller = new AbortController();
    const result = post({ sources, requestKey: 'selected-1' }, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow();
    await entered.promise;
    controller.abort();
    await rejected;
    await drained.promise;
    expect(narrate.mock.calls[0]![3].aborted).toBe(true);
    expect(transport.exchanges[0]!.replied).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('carries the actual dialog request through authentication, Host validation, observation retry and explicit Save', async () => {
    const { post, narrate, write, requireAuth } = fixture();
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const { ChatMemoryDialog } = await vi.importActual<{ ChatMemoryDialog: ComponentType<{
      sessionId: string; sources: ChatMemoryPassage[]; onClose(): void;
    }> }>('@varin/ui/components/pi-session/ChatMemoryDialog');
    const requests: Array<{ sources: ChatMemoryPassage[]; requestKey?: string; retryOf?: string }> = [];
    browser.fetch.mockImplementation(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      return post(body, { path: new URL(path, base).href, ...(init.signal ? { signal: init.signal } : {}) });
    });
    narrate.mockRejectedValueOnce(new MemoryInferenceError('owner-pending', 'Original result pending', 'observe'));
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const click = (text: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text)!.click());
    try {
      await act(async () => root.render(React.createElement(ChatMemoryDialog, { sessionId, sources, onClose() {} })));
      expect(requireAuth).toHaveBeenCalledTimes(1);
      expect(requests[0]).toEqual({ sources, requestKey: expect.any(String) });
      expect(write).not.toHaveBeenCalled();
      narrate.mockRejectedValueOnce(new MemoryInferenceError('owner-stopped', 'Original request stopped before sending', 'new_attempt'));
      await click('chat.context.retry');
      expect(requests[1]).toEqual(requests[0]);
      await click('chat.context.retry');
      expect(requests[2]).toEqual({ sources, requestKey: expect.any(String), retryOf: requests[0]!.requestKey });
      expect(requests[2]!.requestKey).not.toBe(requests[0]!.requestKey);
      expect(narrate.mock.calls[2]![4]).toMatchObject({ requestKey: requests[2]!.requestKey, retryOf: requests[0]!.requestKey,
        sessionId, sources: [{ kind: 'pi-entry', id: 'entry-1', sessionId, revision: sourceRevision(original), start: 0, end: selected.length }] });
      expect(container.querySelector('textarea')?.defaultValue).toBe('Give concise updates.');
      expect(write).not.toHaveBeenCalled();
      write.mockImplementationOnce(async input => ({ created: true, duplicate: false,
        knowledge: { ...input, id: 12, createdAt: 1, recallCount: 0 } }));
      await click('chat.context.save');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]).toEqual([expect.objectContaining({ scope: 'bot', status: 'accepted', content: 'Give concise updates.',
        source: { kind: 'user-extracted', sessionId, spans: [{ kind: 'pi-entry', id: 'entry-1', sessionId,
          revision: sourceRevision(original), start: 0, end: selected.length }] } }), { explicit: true }]);
      expect(container.textContent).toContain('chat.context.saved');
    } finally { await act(async () => root.unmount()); }
  });
});
