import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import { stopDesktopComputerWork } from './computers';

afterEach(() => vi.unstubAllGlobals());

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), runtimeFetch: transport.fetch }));

it('preserves original native Thread, branch and Run in computer operations', async () => {
  vi.stubGlobal('fetch', transport.fetch);
  const work = { runtime: 'agent' as const, threadId: 'thread/one', branchId: 'branch/original' };
  const execution = { work, runId: 'original-run' };
  const state = { work, rootWork: work, currentExecution: null, currentRootExecution: null,
    active: false, status: 'cancel-unconfirmed', leases: [], requests: [], cleanups: [{ execution, desktopId: 'desktop', status: 'cancel-unconfirmed' }] };
  transport.fetch.mockResolvedValueOnce(Response.json({ state, activities: [] })).mockResolvedValueOnce(Response.json({ state }));
  expect((await createThreadsHttpAPI().computer.state(work)).state.cleanups).toEqual(state.cleanups);
  await createThreadsHttpAPI().computer.stop(work, { runId: execution.runId, desktopId: 'desktop' });
  expect(JSON.parse(transport.fetch.mock.calls[1]![1].body)).toMatchObject({ ...work, runId: 'original-run', desktopId: 'desktop' });
});

it('addresses physical desktop Stop only by the captured target epoch and keeps its typed stale failure', async () => {
  transport.fetch.mockReset();
  const control = { desktopId: 'remote/mirror', owner: 'agent', reachable: true, since: 'now', automationEpoch: 'original-epoch', workStatus: 'cancel-unconfirmed' };
  transport.fetch.mockResolvedValueOnce(Response.json({ control, released: false }));
  const result = await stopDesktopComputerWork('remote/mirror', 'original-epoch');
  expect(result).toEqual({ control, released: false });
  expect(transport.fetch.mock.calls[0]![0]).toBe('/api/computers/desktops/remote%2Fmirror/stop');
  expect(JSON.parse(transport.fetch.mock.calls[0]![1].body)).toEqual({ automationEpoch: 'original-epoch' });
  transport.fetch.mockResolvedValueOnce(Response.json({ code: 'computer-execution-stale', error: 'private target diagnostic' }, { status: 409 }));
  await expect(stopDesktopComputerWork('remote/mirror', 'original-epoch')).rejects.toMatchObject({ code: 'computer-execution-stale' });
});
