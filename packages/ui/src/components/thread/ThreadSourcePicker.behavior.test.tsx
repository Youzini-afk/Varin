import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentsAPI, RuntimeAPIs, ThreadIdentity, ThreadPreparedSource, ThreadsAPI } from '@varin/application-client';
import { bindDocumentRegistry, resetDocumentRegistry } from '@/lib/documents/session';
import { unconfiguredWorkspaceEdits } from '@/lib/documents/workspace-edit.test-helper';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { ThreadSourcePicker } from './ThreadSourcePicker';

const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), blockers: new Set<() => Promise<void>>() }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
  registerRuntimeEndpointSwitchBlocker: (blocker: () => Promise<void>) => { endpoint.blockers.add(blocker); return () => endpoint.blockers.delete(blocker); },
}));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'real-thread', branchId: 'real-branch' };
const selected = { workspaceId: 'selected-workspace', resourceId: 'draft.txt' };
const other = { workspaceId: 'other-workspace', resourceId: 'private.txt' };
const prepared: ThreadPreparedSource = {
  path: '/selected', source: { resourceOwner: { kind: 'local' }, mode: 'fixed_branch', workspaceId: selected.workspaceId, executionWorkspaceId: selected.workspaceId, branchId: 'fixed-branch', revision: 7, tools: ['file_read'] },
  provenance: { consistency: 'git-base-with-overlay', contentMode: 'fixed-draft-baseline', captureScopes: ['ignored/data'], omittedDraftPaths: ['ignored/omitted.txt'] },
};
const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  endpoint.generation = 1;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); resetDocumentRegistry(); registerRuntimeAPIs(null);
  container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const settle = async (assertion: () => void) => { await act(async () => { await vi.waitFor(assertion); }); };
const edit = async (label: string, value: string, event = 'change') => {
  const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, writable: true, value }); element.dispatchEvent(new window.Event(event, { bubbles: true })); });
};
async function fixture() {
  const saved = new Map([[selected.workspaceId, 'saved selected'], [other.workspaceId, 'saved other']]);
  let captureCount = 0;
  const capture = vi.fn<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>(async request => ({
    source: 'surface', roots: [...new Set(request.resources.map(entry => entry.resource.workspaceId))].map(workspaceId => ({
      workspaceId, dirtyPaths: request.resources.filter(entry => entry.resource.workspaceId === workspaceId).map(entry => entry.resource.resourceId),
    })), snapshot: { status: 'ready', ref: `opaque-draft-${++captureCount}` },
  }));
  const release = vi.fn<NonNullable<DocumentsAPI['releaseAgentInputSnapshot']>>(async () => ({ released: true }));
  const resolveWorkspace = vi.fn<DocumentsAPI['resolveWorkspace']>(async () => ({ workspaceId: selected.workspaceId, hostId: 'host', epoch: 1 }));
  const write = vi.fn<DocumentsAPI['write']>(async () => { throw new Error('Draft preparation must not save'); });
  const documents: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
    resolveWorkspace,
    resolveResourceIdentity: async resource => ({ coordinationId: `host\0${resource.workspaceId}\0${resource.resourceId}`, aliases: [resource] }),
    read: async resource => ({ status: 'ready', epoch: 1, resource, revision: 'disk-revision', content: saved.get(resource.workspaceId)!, encoding: 'utf-8', bom: false, byteLength: 14 }),
    write, captureAgentInputSnapshot: capture, releaseAgentInputSnapshot: release,
    publishDirtyBuffers: async request => ({ ...request, updatedAt: '2026-10-12T00:00:00.000Z' }),
    clearDirtyBuffers: async () => ({ cleared: true }), watch: () => ({ close() {} }),
    listRecoveryJournals: async () => [], writeRecoveryJournal: async () => ({ status: 'missing', journalId: 'none' }),
    move: async request => ({ status: 'missing', resource: request.from }), delete: async request => ({ status: 'missing', resource: request.resource }),
    readRecoveryJournal: async journalId => ({ status: 'missing', journalId }), deleteRecoveryJournal: async request => ({ status: 'missing', journalId: request.journalId }),
  };
  registerRuntimeAPIs({ documents } as RuntimeAPIs);
  const registry = bindDocumentRegistry(documents);
  await registry.open(selected); await registry.open(other);
  registry.applyTransaction(selected, 'selected unsaved', { origin: 'editor' });
  registry.applyTransaction(other, 'unrelated unsaved', { origin: 'editor' });
  const prepareSource = vi.fn<ThreadsAPI['prepareSource']>(async () => prepared);
  const sources: ThreadsAPI['sources'] = {
    list: vi.fn<ThreadsAPI['sources']['list']>(async () => ({ targets: [{ resourceOwner: { kind: 'local' }, label: 'This Host', capabilities: [] }], unavailable: [] })),
    resolve: vi.fn(async (_identity, request) => ({ resourceOwner: request.resourceOwner, path: request.path, workspaceId: (await documents.resolveWorkspace({ path: request.path })).workspaceId })),
  };
  const api: Pick<ThreadsAPI, 'prepareSource' | 'sources'> = { prepareSource, sources };
  const onPrepared = vi.fn(); const onPreparingChange = vi.fn();
  const render = async (owner = identity, currentApi = api) => { await act(async () => root.render(
    <ThreadSourcePicker api={currentApi} identity={owner} initialPath="/selected" active={false} launch={null}
      prepared={onPrepared.mock.calls.at(-1)?.[0] ?? null} onPrepared={onPrepared} onPreparingChange={onPreparingChange} />,
  )); };
  await render();
  return { saved, documents, registry, capture, release, resolveWorkspace, write, prepareSource, api, onPrepared, onPreparingChange, render };
}

it('captures the selected Documents root once, retries identical draft bytes and scopes, then shows actual provenance', async () => {
  const f = await fixture();
  f.prepareSource.mockRejectedValueOnce(new Error('uncertain preparation'));
  await edit('Snapshot content', 'surface-drafts');
  await edit('Additional capture paths', 'ignored/data', 'input');
  await click('Prepare workspace');
  await settle(() => expect(f.prepareSource).toHaveBeenCalledOnce());
  expect(f.resolveWorkspace).toHaveBeenCalledWith({ path: '/selected' });
  expect(f.capture).toHaveBeenCalledOnce();
  const captured = f.capture.mock.calls[0]![0];
  expect(captured.consumer).toEqual({ kind: 'thread', threadId: identity.threadId, branchId: identity.branchId });
  expect(captured.resources.map(entry => [entry.resource, entry.content])).toEqual([[selected, 'selected unsaved']]);
  expect(f.prepareSource.mock.calls[0]![0]).toMatchObject({ ...identity, workspaceId: selected.workspaceId, captureScopes: ['ignored/data'], content: {
    mode: 'surface-drafts', context: { source: 'surface', roots: [{ workspaceId: selected.workspaceId, dirtyPaths: ['draft.txt'] }], snapshot: { status: 'ready', ref: 'opaque-draft-1' } },
  } });
  f.registry.applyTransaction(selected, 'later user draft', { origin: 'editor' });
  f.resolveWorkspace.mockRejectedValue(new Error('The selected symlink alias no longer resolves'));
  await click('Prepare workspace');
  expect(f.prepareSource.mock.calls[1]![0]).toBe(f.prepareSource.mock.calls[0]![0]);
  expect(f.prepareSource.mock.calls[1]![0]).not.toHaveProperty('path');
  expect(f.resolveWorkspace.mock.calls.filter(([input]) => input.path !== undefined)).toHaveLength(1);
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledExactlyOnceWith({ consumer: captured.consumer, context: f.prepareSource.mock.calls[0]![0].content.mode === 'surface-drafts' ? f.prepareSource.mock.calls[0]![0].content.context : null });
  await f.render();
  expect(container.querySelector('[aria-label="Capture provenance"]')?.textContent).toContain('git-base-with-overlay');
  expect(container.textContent).toContain('fixed-draft-baseline'); expect(container.textContent).toContain('ignored/omitted.txt');
  expect(container.textContent).toContain('Fixed revision: 7');
  expect(f.registry.get(selected)?.buffer).toBe('later user draft'); expect(f.registry.get(other)?.buffer).toBe('unrelated unsaved');
  expect(f.saved.get(selected.workspaceId)).toBe('saved selected'); expect(f.write).not.toHaveBeenCalled();
});

it('retries a saved-files request by the original workspace identity after its path alias becomes unavailable', async () => {
  const f = await fixture();
  f.prepareSource.mockRejectedValueOnce(new Error('response lost after source preparation'));
  await click('Prepare workspace');
  expect(f.prepareSource).toHaveBeenCalledOnce();
  const original = f.prepareSource.mock.calls[0]![0];
  expect(original).toMatchObject({ ...identity, workspaceId: selected.workspaceId, content: { mode: 'saved-files' }, captureScopes: [] });
  expect(original).not.toHaveProperty('path');
  f.resolveWorkspace.mockRejectedValue(new Error('The selected symlink alias no longer resolves'));
  await click('Prepare workspace');
  expect(f.prepareSource.mock.calls[1]![0]).toBe(original);
  expect(f.resolveWorkspace.mock.calls.filter(([input]) => input.path !== undefined)).toHaveLength(1);
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.onPrepared).toHaveBeenLastCalledWith(prepared);
});

it('keeps an explicit draft selection when only another workspace is dirty and keeps live roots saved-only', async () => {
  const f = await fixture();
  f.registry.applyTransaction(selected, 'saved selected', { origin: 'editor' });
  await edit('Snapshot content', 'surface-drafts'); await click('Prepare workspace');
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.prepareSource.mock.calls[0]![0].content).toEqual({ mode: 'surface-drafts', context: { source: 'disk' } });
  await edit('Workspace access', 'live_root'); await click('Prepare workspace');
  expect(f.prepareSource.mock.calls[1]![0]).toMatchObject({ mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [] });
  expect(container.querySelector('[aria-label="Snapshot content"]')).toBeNull();
});

it('aborts preparation and releases its snapshot on input changes, cancellation and Thread replacement', async () => {
  const f = await fixture();
  const late = gate<ThreadPreparedSource>(); f.prepareSource.mockImplementation(() => late.promise);
  await edit('Snapshot content', 'surface-drafts'); await click('Prepare workspace');
  await settle(() => expect(f.prepareSource).toHaveBeenCalledOnce());
  const first = f.prepareSource.mock.calls[0]!;
  await edit('Additional capture paths', 'ignored/new', 'input');
  expect(first[1]?.aborted).toBe(true); expect(f.release).toHaveBeenCalledOnce();
  await act(async () => late.resolve(prepared));
  expect(f.onPrepared).not.toHaveBeenCalledWith(prepared);
  const next = gate<ThreadPreparedSource>(); f.prepareSource.mockImplementation(() => next.promise);
  await click('Prepare workspace'); await settle(() => expect(f.prepareSource).toHaveBeenCalledTimes(2)); const second = f.prepareSource.mock.calls[1]!;
  expect(second[0].key).not.toBe(first[0].key); expect(f.capture).toHaveBeenCalledTimes(2);
  await click('Cancel preparation'); expect(second[1]?.aborted).toBe(true); expect(f.release).toHaveBeenCalledTimes(2);
  await click('Prepare workspace'); await settle(() => expect(f.prepareSource).toHaveBeenCalledTimes(3)); const third = f.prepareSource.mock.calls[2]!;
  await f.render({ ...identity, branchId: 'different-branch' });
  expect(third[1]?.aborted).toBe(true); expect(f.release).toHaveBeenCalledTimes(3);
  await act(async () => next.resolve(prepared)); expect(f.onPrepared).not.toHaveBeenCalledWith(prepared);
});

it('releases a late capture before switching Hosts and never sends it to the next owner', async () => {
  const f = await fixture();
  const late = gate<Awaited<ReturnType<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>>>();
  f.capture.mockImplementation(() => late.promise);
  await edit('Snapshot content', 'surface-drafts'); await click('Prepare workspace');
  await settle(() => expect(f.capture).toHaveBeenCalledOnce());
  await act(async () => {
    const switching = Promise.all([...endpoint.blockers].map(blocker => blocker()));
    late.resolve({ source: 'surface', roots: [{ workspaceId: selected.workspaceId, dirtyPaths: ['draft.txt'] }], snapshot: { status: 'ready', ref: 'late-capture' } });
    await switching; endpoint.generation += 1; endpoint.listeners.forEach(listener => listener());
  });
  expect(f.prepareSource).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledExactlyOnceWith({ consumer: { kind: 'thread', threadId: identity.threadId, branchId: identity.branchId },
    context: { source: 'surface', roots: [{ workspaceId: selected.workspaceId, dirtyPaths: ['draft.txt'] }], snapshot: { status: 'ready', ref: 'late-capture' } } });
  expect(f.onPreparingChange).toHaveBeenLastCalledWith(false);
});

it('does not recapture or fall back to disk after a failed draft capture without an explicit new request', async () => {
  const f = await fixture();
  f.capture.mockRejectedValueOnce(new Error('capture failed'));
  await edit('Snapshot content', 'surface-drafts'); await click('Prepare workspace');
  await settle(() => { expect(f.capture).toHaveBeenCalledOnce(); expect(f.onPreparingChange).toHaveBeenLastCalledWith(false); });
  expect(container.textContent).toContain('Editor drafts could not be captured');
  await click('Prepare workspace'); expect(f.capture).toHaveBeenCalledOnce(); expect(f.prepareSource).not.toHaveBeenCalled();
  await click('Capture drafts again');
  await settle(() => expect(f.prepareSource).toHaveBeenCalledOnce());
  expect(f.capture).toHaveBeenCalledTimes(2); expect(f.prepareSource).toHaveBeenCalledOnce();
  expect(f.prepareSource.mock.calls[0]![0].content.mode).toBe('surface-drafts');
});


it('freezes the managed Host and resolves its Documents workspace once without consulting local editors', async () => {
  const f = await fixture();
  f.resolveWorkspace.mockClear();
  const resourceOwner = { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'saved-b', endpointIdentity: 'sha256-endpoint-b' };
  const remotePrepared: ThreadPreparedSource = { ...prepared, path: '/same-folder', source: { ...prepared.source, resourceOwner, workspaceId: 'b-documents-workspace', executionWorkspaceId: 'b-documents-workspace' } };
  const resolve = vi.fn<ThreadsAPI['sources']['resolve']>(async (_identity, request) => ({ resourceOwner: request.resourceOwner, workspaceId: 'b-documents-workspace', path: '/same-folder' }));
  const sources: ThreadsAPI['sources'] = { list: async () => ({ targets: [{ resourceOwner: { kind: 'local' }, label: 'This Host', capabilities: [] },
    { resourceOwner, label: 'Remote B', capabilities: ['sources'] }], unavailable: [] }), resolve };
  const api = { ...f.api, sources };
  f.prepareSource.mockRejectedValueOnce(new Error('Remote receipt response lost')).mockResolvedValue(remotePrepared);
  await f.render(identity, api);
  await edit('Source Host', JSON.stringify([resourceOwner.connectionId, resourceOwner.endpointIdentity, resourceOwner.hostId]));
  await edit('Workspace folder', '/same-folder', 'input');
  await click('Prepare workspace');
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]![1]).toEqual({ resourceOwner, path: '/same-folder' });
  const original = f.prepareSource.mock.calls[0]![0];
  expect(original).toMatchObject({ resourceOwner, workspaceId: 'b-documents-workspace', content: { mode: 'saved-files' } });
  resolve.mockRejectedValue(new Error('Remote alias moved'));
  await click('Prepare workspace');
  expect(f.prepareSource.mock.calls[1]![0]).toBe(original);
  expect(resolve).toHaveBeenCalledOnce();
  expect(f.resolveWorkspace).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
  await f.render(identity, api);
  expect(container.querySelector('[aria-label="Prepared workspace"]')?.textContent).toContain('Remote B');
  expect(container.textContent).toContain('Available source tools: file_read');
});
