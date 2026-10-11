import { expect, it, vi } from 'vitest';
import { ThreadRequestError } from '@varin/application-client';
import { readComputerAutomation, stopComputerAutomation, stopDesktopComputerWork } from './computers';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), runtimeFetch: transport.fetch }));

it('preserves the real Pi route and exact Stop Run while decoding original cleanup and typed failures', async () => {
  const work = { runtime: 'pi' as const, sessionId: 'pi/session' };
  const execution = { work, runId: 'original-run' };
  const state = { work, rootWork: work, currentExecution: null, currentRootExecution: null,
    active: false, status: 'cancel-unconfirmed', leases: [], requests: [], cleanups: [{ execution, desktopId: 'desktop', status: 'cancel-unconfirmed' }] };
  transport.fetch.mockResolvedValueOnce(Response.json({ state, activities: [] })).mockResolvedValueOnce(Response.json({ state }));
  const controller = new AbortController();
  expect((await readComputerAutomation(work, controller.signal)).state.cleanups).toEqual(state.cleanups);
  expect(transport.fetch.mock.calls[0]).toEqual(['/api/computers/automation?sessionId=pi%2Fsession', { cache: 'no-store', signal: controller.signal }]);
  await stopComputerAutomation(execution, 'desktop');
  expect(transport.fetch.mock.calls[1]![0]).toBe('/api/computers/automation/stop');
  expect(JSON.parse(transport.fetch.mock.calls[1]![1].body)).toEqual({ sessionId: work.sessionId, runId: execution.runId, desktopId: 'desktop' });
  transport.fetch.mockResolvedValueOnce(Response.json({ code: 'computer-owner-unavailable', error: 'private owner diagnostic' }, { status: 409 }));
  await expect(stopComputerAutomation(execution, 'desktop')).rejects.toMatchObject({ name: 'ThreadRequestError', code: 'computer-owner-unavailable' } satisfies Partial<ThreadRequestError>);
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
