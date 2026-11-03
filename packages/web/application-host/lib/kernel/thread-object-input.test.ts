import { expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { createThreadObjectInputPreparer, parseThreadObjectReferences } from './thread-object-input.js';
import { resourceSource } from './thread-context.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:caller', branchId: 'branch:caller' };
const live: ThreadSource = { resourceOwner: { kind: 'local' }, workspaceId: 'workspace:original', executionWorkspaceId: 'workspace:original',
  mode: 'live_root', liveRoot: { hostId: 'host', rootId: 'root', canonicalRoot: '/original' }, tools: ['file_read'] };
const fixed: ThreadSource = { resourceOwner: { kind: 'local' }, workspaceId: 'workspace:original', executionWorkspaceId: 'workspace:owned',
  mode: 'fixed_branch', branchId: 'source:fixed', revision: 7, tools: ['file_read'] };
function fixture() {
  const runtime = {
    familyList: vi.fn<AgentRuntimeClient['familyList']>(async () => ({ rootThreadId: identity.threadId, members: [] })),
    thread: vi.fn<AgentRuntimeClient['thread']>(async () => ({ branches: [
      { branch_id: 'branch:other', active_run_id: 'run:wrong' },
      { branch_id: identity.branchId, active_run_id: 'run:current', latest_run: { id: 'run:previous' } },
    ] } as Awaited<ReturnType<AgentRuntimeClient['thread']>>)),
    launch: vi.fn<AgentRuntimeClient['launch']>(async () => ({ selection: { source: resourceSource(live) } } as Awaited<ReturnType<AgentRuntimeClient['launch']>>)),
  };
  const admitSource = vi.fn(async () => {});
  return { runtime, admitSource, prepare: createThreadObjectInputPreparer({ runtime, admitSource }) };
}
function threadReference(text: string, threadId = 'thread:target', branchId = 'branch:target') {
  return { kind: 'thread' as const, threadId, branchId, start: text.indexOf('@'), end: text.length };
}
function directoryReference(text: string, path: string) {
  return { kind: 'directory' as const, path, start: text.indexOf('@'), end: text.length };
}

it('authorizes exact task branches through paginated family metadata without opening histories or selecting a recipient', async () => {
  const f = fixture();
  f.runtime.familyList.mockResolvedValueOnce({ rootThreadId: identity.threadId, nextCursor: 'next', members: [] });
  f.runtime.familyList.mockResolvedValueOnce({ rootThreadId: identity.threadId, members: [{ threadId: 'thread:target', parentThreadId: identity.threadId,
    task: 'Renamed task', state: 'completed', branches: [{ branchId: 'branch:target', headId: null, activeRunId: null, latestRun: null }] }] });
  const text = '请参考 @原任务'; const references = [threadReference(text)];
  const output = await f.prepare({ ...identity, text, references });
  expect(output.startsWith(text)).toBe(true);
  expect(output).toContain('"threadId":"thread:target","branchId":"branch:target"');
  expect(output).not.toContain('Renamed task');
  expect(references).toEqual([threadReference(text)]);
  expect(f.runtime.familyList.mock.calls.map(([request]) => request)).toEqual([
    { callerThreadId: identity.threadId, includeSelf: true }, { callerThreadId: identity.threadId, includeSelf: true, cursor: 'next' },
  ]);
  expect(f.runtime.thread).not.toHaveBeenCalled(); expect(f.runtime.launch).not.toHaveBeenCalled(); expect(f.admitSource).not.toHaveBeenCalled();
});

it('rejects a same-thread wrong branch, unreachable target and cyclic family pages', async () => {
  const f = fixture(); const text = '@task';
  f.runtime.familyList.mockResolvedValue({ rootThreadId: identity.threadId, nextCursor: 'cycle', members: [{ threadId: 'thread:target', parentThreadId: null,
    task: null, state: 'running', branches: [{ branchId: 'branch:other', headId: null, activeRunId: null, latestRun: null }] }] });
  await expect(f.prepare({ ...identity, text, references: [threadReference(text)] })).rejects.toMatchObject({ code: 'reference-denied' });
  expect(f.runtime.familyList).toHaveBeenCalledTimes(2);
});

it('binds current directories to the exact branch active Run and retains explicit fixed-source identity', async () => {
  const f = fixture(); const text = '查看 @src';
  const input = { ...identity, text, references: [directoryReference(text, '/original/src')] };
  const output = await f.prepare(input);
  expect(f.runtime.launch).toHaveBeenCalledExactlyOnceWith('run:current', undefined);
  expect(f.admitSource).toHaveBeenCalledWith({ ...live, tools: [] }, input, 'run:current', undefined);
  expect(output).toContain('"mode":"live_root"'); expect(output).toContain('"rootId":"root"');
  f.runtime.launch.mockClear(); f.runtime.thread.mockClear();
  const pending = await f.prepare({ ...identity, text, references: [directoryReference(text, 'src')], source: fixed });
  expect(pending).toContain('"branch_id":"source:fixed","revision":7');
  expect(pending).toContain('"execution_workspace_id":"workspace:owned"');
  expect(pending).not.toContain('file_read');
  expect(f.runtime.launch).not.toHaveBeenCalled(); expect(f.runtime.thread).not.toHaveBeenCalled();
});

it('rejects escaped and mismatched directory namespaces and refuses a source-free directory', async () => {
  const f = fixture(); const text = '@dir';
  for (const directory of ['../outside', 'src/../../outside', '/outside', 'C:\\outside', '\\\\other\\share']) {
    await expect(f.prepare({ ...identity, text, references: [directoryReference(text, directory)], source: live })).rejects.toMatchObject({ code: 'reference-invalid' });
  }
  await expect(f.prepare({ ...identity, text, references: [directoryReference(text, '/original/src')], source: fixed })).rejects.toMatchObject({ code: 'reference-invalid' });
  f.runtime.launch.mockResolvedValue(null);
  await expect(f.prepare({ ...identity, text, references: [directoryReference(text, 'src')] })).rejects.toMatchObject({ code: 'reference-unavailable' });
});

it('rejects forged fields and stale ranges, and fences cancellation after original source admission', async () => {
  const text = '🌱 @src'; const reference = directoryReference(text, 'src');
  expect(parseThreadObjectReferences([reference], text)).toEqual([reference]);
  for (const forged of [{ ...reference, recipient: 'other' }, { ...reference, start: 1 }, { ...reference, end: text.length + 1 }]) {
    expect(() => parseThreadObjectReferences([forged], text)).toThrow();
  }
  expect(() => parseThreadObjectReferences([reference, reference], text)).toThrow();
  const f = fixture(); const controller = new AbortController();
  f.admitSource.mockImplementation(async () => { controller.abort(); });
  await expect(f.prepare({ ...identity, text, references: [reference], source: live }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
