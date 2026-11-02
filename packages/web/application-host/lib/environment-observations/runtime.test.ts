import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createEnvironmentObservationRuntime, type GitStatusEvent } from './runtime.js';
import type { ObservationPort } from './coordinator.js';
import type { ContextObservationSource, EnvironmentObservationCapture, EnvironmentObservationReceipt } from '../kernel/protocol.generated.js';

const owner = (id = 'a'): ContextObservationSource => ({ threadId: `thread:${id}`, branchId: `branch:${id}`, runId: `run:${id}`, anchorId: `input:${id}`, epoch: 1,
  source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: 'ws', execution_workspace_id: 'ws', branch_id: null, revision: null,
    live_root: { hostId: 'host', rootId: 'root', canonicalRoot: '/workspace' } } });
const sorted = (value: unknown): unknown => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort().map(([key, item]) => [key, sorted(item)])) : value;
const receipt = (capture: EnvironmentObservationCapture): EnvironmentObservationReceipt => ({ captureId: capture.captureId, id: `native:${capture.captureId}`, cursor: 1,
  rawDigest: `sha256-${createHash('sha256').update(JSON.stringify(sorted(capture.event))).digest('hex')}`, rawRef: 'raw',
  representation: { version: 1, digest: 'projection', bytes: 10, bodyBudgetBytes: 8192, omitted: false }, admission: { cursor: 10, state: 'queued' } });
const fixture = (owners = [owner()]) => ({ sources: vi.fn(async (_id?: string) => owners),
  capture: vi.fn(async (_owner: ContextObservationSource, captures: EnvironmentObservationCapture[]) => captures.map(receipt)),
  receipt: vi.fn(async (_owner: ContextObservationSource, _ids: string[]): Promise<EnvironmentObservationReceipt[]> => []), snapshot: vi.fn(async () => ({ cursor: 0 })) } satisfies ObservationPort);

let sample = 0;
const git = (event: Omit<GitStatusEvent, 'sampleId' | 'observedAt' | 'branchChanged'> & { branchChanged?: boolean }): GitStatusEvent => ({ branchChanged: false, ...event, sampleId: `git:${++sample}`, observedAt: sample });

it('captures a long terminal command as one typed raw body without a second formatted text copy', async () => {
  const port = fixture(), runtime = createEnvironmentObservationRuntime({ port, incarnation: 'host-one' });
  const command = 'x'.repeat(100_000), event = { workspaceId: 'ws', sessionId: 'terminal:1', commandId: 'generation:3:command:8', command,
    exitCode: 0, source: 'user' as const, endedAt: 33, cwd: '/workspace' };
  await runtime.observeTerminalCommand(event); await runtime.observeTerminalCommand(event);
  await runtime.dispose();
  expect(port.capture).toHaveBeenCalledOnce(); const [capture] = port.capture.mock.calls[0]![1];
  expect(capture?.captureId).toBe('terminal:host-one:terminal:1:generation:3:command:8');
  expect(capture?.event).toEqual({ kind: 'command', at: 33, source: 'user', body: { terminalId: 'terminal:1', commandId: event.commandId, changeId: 'terminal:host-one:terminal:1:generation:3:command:8',
    command, cwd: '/workspace', exitCode: 0, endedAt: 33 } });
  const encoded = JSON.stringify(capture);
  expect(encoded.indexOf(command)).toBe(encoded.lastIndexOf(command)); expect(encoded.length).toBeLessThan(101_000);
});

it('retains distinct Git A-B-A samples while suppressing only consecutive identical state', async () => {
  const port = fixture(), runtime = createEnvironmentObservationRuntime({ port });
  for (const [index, branch] of ['main', 'main', 'topic', 'main'].entries()) runtime.observeGitStatus(git({ workspaceId: 'ws', branch, changed: 0, branchChanged: index >= 2 }));
  await runtime.dispose(); const captures = port.capture.mock.calls.flatMap(([, batch]) => batch);
  expect(captures.map(item => item.event.kind === 'source' && item.event.body.branch)).toEqual(['main', 'topic', 'main']);
  expect(captures.map(item => item.event.kind === 'source' && item.event.body.notifyAssistant)).toEqual([false, true, true]);
  expect(new Set(captures.map(item => item.captureId)).size).toBe(3);
});

it('ignores Agent writes and fixed/remote sources instead of borrowing a local workspace', async () => {
  const fixed = owner('fixed'); fixed.source.mode = 'fixed_branch';
  const remote = owner('remote'); remote.source.resource_owner = { kind: 'managed_host', hostId: 'elsewhere', connectionId: 'connection', endpointIdentity: 'endpoint' };
  const port = fixture([fixed, remote, owner()]), runtime = createEnvironmentObservationRuntime({ port });
  expect(runtime.observeDocumentMutation({ workspaceId: 'ws', resourceId: 'file', kind: 'modified', changeId: 'agent', observedAt: 1,
    owner: { kind: 'agent-runtime', id: 'tool' } })).toBeNull();
  runtime.observeDocumentMutation({ workspaceId: 'ws', resourceId: 'file', kind: 'modified', changeId: 'user', observedAt: 2,
    operationId: 'operation', owner: { kind: 'web-route', id: 'save' } });
  await runtime.dispose(); expect(port.capture).toHaveBeenCalledOnce();
  expect(port.capture.mock.calls[0]?.[0]).toEqual(owner());
  expect(port.capture.mock.calls[0]?.[1][0]?.event).toMatchObject({ at: 2, body: { operationId: 'operation', changeId: 'user' } });
});

it('fans out one terminal capture to each current trusted Thread owner', async () => {
  const port = fixture([owner(), owner('b')]), runtime = createEnvironmentObservationRuntime({ port, incarnation: 'host' });
  await runtime.observeTerminalCommand({ workspaceId: 'ws', sessionId: 'terminal', commandId: 'one', command: 'pwd', exitCode: 0, source: 'user', endedAt: 1 });
  await runtime.dispose(); expect(port.capture.mock.calls.map(([source]) => source.runId)).toEqual(['run:a', 'run:b']);
});

it('bounds the pre-binding producer queue while a trusted Catalog source query is held', async () => {
  const port = fixture(); let release!: (owners: ContextObservationSource[]) => void;
  port.sources.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const runtime = createEnvironmentObservationRuntime({ port, budgets: { sourceCaptures: 2 } });
  runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'one' }));
  await vi.waitFor(() => expect(port.sources).toHaveBeenCalledOnce());
  expect(runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'two' })).state).toBe('pending');
  expect(runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'three' })).state).toBe('gap');
  port.sources.mockResolvedValue([owner()]); release([owner()]);
  const result = await runtime.dispose();
  expect(result.producerGaps).toMatchObject([{ workspaceId: 'ws', count: 1, reason: 'queue_budget' }]);
  expect(port.capture.mock.calls.flatMap(([, batch]) => batch)).toHaveLength(2);
});

it('reports a failed pre-binding read as unavailable coverage without retrying against a new source', async () => {
  const port = fixture(); port.sources.mockRejectedValue(new Error('Catalog connection unavailable'));
  const error = vi.fn(), runtime = createEnvironmentObservationRuntime({ port, onError: error });
  runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'main' }));
  const result = await runtime.dispose(); expect(port.capture).not.toHaveBeenCalled();
  expect(result.producerGaps).toMatchObject([{ reason: 'source_unavailable', count: 1 }]); expect(error).toHaveBeenCalledOnce();
});

it('allows fresh Git state after queue pressure and preserves an A-B(gap)-A transition', async () => {
  const port = fixture(); let release!: (receipts: EnvironmentObservationReceipt[]) => void;
  port.capture.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const runtime = createEnvironmentObservationRuntime({ port, budgets: { sourceCaptures: 1 } });
  runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'main' }));
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledOnce());
  runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'topic' }));
  await vi.waitFor(() => expect(runtime.inspect()[0]?.gap?.count).toBe(1));
  release(port.capture.mock.calls[0]![1].map(receipt));
  await vi.waitFor(() => expect(runtime.inspect()[0]?.pending).toEqual([]));
  runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'main', branchChanged: true }));
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(runtime.inspect()[0]?.pending).toEqual([]));
  runtime.observeGitStatus(git({ workspaceId: 'ws', branch: 'topic' })); await runtime.dispose();
  const captures = port.capture.mock.calls.flatMap(([, batch]) => batch);
  expect(captures.map(item => item.event.kind === 'source' && item.event.body.branch)).toEqual(['main', 'main', 'topic']);
  expect(captures[1]?.event).toMatchObject({ body: { notifyAssistant: true } });
  expect(captures[2]?.event).toMatchObject({ body: { notifyAssistant: false } });
  expect(runtime.inspect()[0]?.gap?.count).toBe(1);
});

it('reports producer pending work and coverage gaps only for the requesting source workspace', async () => {
  const a = owner(), b = owner('b'); b.source = { ...b.source, workspace_id: 'other', execution_workspace_id: 'other' };
  const port = fixture([a, b]);
  const runtime = createEnvironmentObservationRuntime({ port, budgets: { sourceBytes: 1 } });
  runtime.observeGitStatus(git({ workspaceId: 'other', branch: 'main' }));
  port.sources.mockImplementation(async id => id === a.runId ? [a] : [a, b]);
  const prepared = await runtime.prepare({ id: a.runId });
  expect(prepared.producerPending).toBe(0); expect(prepared.producerGaps).toEqual([]);
  const shutdown = await runtime.dispose(); expect(shutdown.producerGaps).toMatchObject([{ workspaceId: 'other', count: 1 }]);
});

it('reports a conflicting duplicate without losing later distinct captures in the same producer burst', async () => {
  const port = fixture(), error = vi.fn(), runtime = createEnvironmentObservationRuntime({ port, onError: error });
  const original = { workspaceId: 'ws', resourceId: 'first.md', kind: 'modified' as const, changeId: 'same', observedAt: 1,
    owner: { kind: 'web-route', id: 'editor' } };
  runtime.observeDocumentMutation(original); runtime.observeDocumentMutation({ ...original, resourceId: 'changed.md' });
  runtime.observeDocumentMutation({ ...original, changeId: 'later', resourceId: 'last.md' }); await runtime.dispose();
  expect(port.capture.mock.calls.flatMap(([, batch]) => batch).map(item => item.captureId)).toEqual(['document:same', 'document:later']);
  expect(runtime.inspect()[0]?.gap?.count).toBe(1); expect(error).toHaveBeenCalledOnce();
});

it('keeps the original Git transition flag and timestamp when a prior sample is delivered again', async () => {
  const port = fixture(), runtime = createEnvironmentObservationRuntime({ port });
  const a = git({ workspaceId: 'ws', branch: 'main', branchChanged: false });
  const b = git({ workspaceId: 'ws', branch: 'topic', branchChanged: true });
  runtime.observeGitStatus(a); runtime.observeGitStatus(b); runtime.observeGitStatus(a);
  await runtime.dispose();
  const captures = port.capture.mock.calls.flatMap(([, batch]) => batch);
  expect(captures).toHaveLength(2);
  expect(captures[0]).toMatchObject({ captureId: a.sampleId, event: { at: a.observedAt, body: { notifyAssistant: false, changeId: a.sampleId } } });
  expect(captures[1]).toMatchObject({ captureId: b.sampleId, event: { at: b.observedAt, body: { notifyAssistant: true } } });
  expect(runtime.inspect()[0]?.gap).toBeNull();
});
