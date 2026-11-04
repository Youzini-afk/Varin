import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { beforeEach, expect, it, vi } from 'vitest';
import { latestUiRevision } from './latest-revision';
import { uiSession } from './sessions';
const source = vi.hoisted(() => vi.fn());
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createInteractiveUiHttpAPI: () => ({ source }) }));
beforeEach(() => { source.mockReset(); });
function original() {
  const session = uiSession(`latest:${crypto.randomUUID()}`, { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, getRuntimeEndpointGeneration());
  session.display = { source: { ref: 'ui:work@1' }, files: { 'index.html': '<p>old</p>' }, assets: {}, entry: 'index.html', title: 'Old', committed: true, status: '' };
  session.viewRef = 'ui-view:old'; session.state = { data: { selection: 'old' }, controls: {}, scroll: { x: 0, y: 99 } };
  return session;
}
it('opens the requested latest fixed revision separately without retargeting historic state', async () => {
  const historical = original(), display = historical.display, state = historical.state;
  source.mockResolvedValue({ ref: 'ui:work@3', workRef: 'ui:work', contents: { 'index.html': '<p>new</p>' }, assets: {}, entry: 'index.html', title: 'New' });
  const latest = await latestUiRevision(historical);
  expect(source).toHaveBeenCalledWith(historical.identity, 'ui:work');
  expect(latest?.display?.source.ref).toBe('ui:work@3');
  expect(latest?.key).not.toBe(historical.key); expect(latest?.state).toBeUndefined();
  expect(historical.display).toBe(display); expect(historical.state).toBe(state); expect(historical.viewRef).toBe('ui-view:old');
});
it('reports same revision and leaves historical content readable after owner failure', async () => {
  const historical = original(); source.mockResolvedValue({ ref: 'ui:work@1' });
  expect(await latestUiRevision(historical)).toBeUndefined();
  source.mockRejectedValue(new Error('Work is unavailable'));
  await expect(latestUiRevision(historical)).rejects.toThrow('Work is unavailable');
  expect(historical.display?.source.ref).toBe('ui:work@1');
});
