import { getRuntimeEndpointGeneration, normalizeConversationUi } from '@varin/application-client';
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
  expect(latest?.initialState).toEqual(state); expect(latest?.initialState).not.toBe(state);
  expect(historical.display).toBe(display); expect(historical.state).toBe(state); expect(historical.viewRef).toBe('ui-view:old');
});
it('migrates compatible selections independently and leaves later destination edits intact', async () => {
  const historical = original();
  historical.display!.content = normalizeConversationUi({ type: 'choice', key: 'choice', label: 'Plan', multiple: true, options: ['A', 'B'] });
  historical.state = { data: { choice: ['label:A', 'label:B'] }, controls: {}, scroll: { x: 0, y: 0 } };
  source.mockResolvedValue({ ref: 'ui:work@2', workRef: 'ui:work', content: normalizeConversationUi({ type: 'choice', key: 'choice', label: 'Plan', multiple: true, options: ['B', 'C'] }), contents: {}, assets: {}, entry: '', title: 'Plan' });
  const latest = (await latestUiRevision(historical))!;
  expect(latest.initialState?.data).toEqual({ choice: ['label:B'] });
  expect(latest.initialState?.controls.__varinResetKeys).toEqual(['choice']);
  latest.state = { data: { choice: ['label:C'] }, controls: {}, scroll: { x: 0, y: 0 } };
  await latestUiRevision(historical);
  expect(latest.state.data).toEqual({ choice: ['label:C'] });
  expect(historical.state.data).toEqual({ choice: ['label:A', 'label:B'] });
});
it('reports same revision and leaves historical content readable after owner failure', async () => {
  const historical = original(); source.mockResolvedValue({ ref: 'ui:work@1' });
  expect(await latestUiRevision(historical)).toBeUndefined();
  source.mockRejectedValue(new Error('Work is unavailable'));
  await expect(latestUiRevision(historical)).rejects.toThrow('Work is unavailable');
  expect(historical.display?.source.ref).toBe('ui:work@1');
});
