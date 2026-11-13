import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Followup } from '@varin/protocol';
import type { ThreadFollowupsAPI } from '@varin/application-client';
import { BotArrangements } from './BotSchedulePane';
import { BotPanelContext, type BotPanelModel } from './botPanelModel';
import { useBotFacts } from './useBotFacts';

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ openArrangements: state.open }) } }));
vi.mock('@/lib/bots', () => ({ listBotMemory: async () => [], listBotSchedules: async () => [], readBotActivity: async () => ({ events: [], participants: [], before: null }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: object) => key + (params ? JSON.stringify(params) : '') }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
const entry = { runtime: 'agent' as const, threadId: 'bot-entry', branchId: 'main' };
const item = { id: 'watch-replies', thread_id: entry.threadId, branch_id: entry.branchId, name: 'Watch customer replies', trigger: { kind: 'plugin_event', source: { extensionId: 'mail', sourceId: 'incoming', connectionId: 'work', accountId: 'account' } }, state: 'active', repeat: 'each', timing: { kind: 'passive' }, pending_events: 3, pending_occurrences: 0, next_delivery_at_ms: null, source_status: null } as Followup;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); state.open.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
function Harness({ api, revision = 0 }: { api: ThreadFollowupsAPI; revision?: number }) {
  const facts = useBotFacts({ botId: 'bot', identity: entry, followups: api, enabled: true, revision });
  const model = { bot: { id: 'bot', entry: { ...entry, threadId: 'deleted-profile-entry', branchId: 'deleted-branch' } }, threads: { followups: api }, facts } as unknown as BotPanelModel;
  return <BotPanelContext.Provider value={model}><BotArrangements /></BotPanelContext.Provider>;
}
it('reads and opens management through the resolved session instead of the deleted profile entry', async () => {
  const arrangements = vi.fn().mockResolvedValue([item]);
  const eventSources = vi.fn().mockResolvedValue([{ extensionId: 'mail', sourceId: 'incoming', displayName: 'Customer inbox', connections: [{ connectionId: 'work', accountId: 'account', displayName: 'Work mailbox' }] }]);
  const api = { arrangements, eventSources } as unknown as ThreadFollowupsAPI;
  await act(async () => root.render(<Harness api={api} />));
  expect(arrangements).toHaveBeenCalledWith(entry, 'bot', expect.any(AbortSignal));
  expect(container.textContent).toContain('Watch customer replies');
  expect(container.textContent).toContain('Customer inbox · Work mailbox');
  expect(container.textContent).toContain('arrangements.pending{"count":3}');
  expect(container.textContent).toContain('arrangements.unknownHealth');
  await act(async () => container.querySelector('button')!.click());
  expect(state.open).toHaveBeenCalledWith(entry, item.id);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'arrangements.manage')!.click());
  expect(state.open).toHaveBeenLastCalledWith(entry, undefined);
  arrangements.mockRejectedValueOnce(new Error('List unavailable'));
  await act(async () => root.render(<Harness api={api} revision={1} />));
  expect(container.textContent).toContain('List unavailable');
  expect(container.textContent).toContain('Watch customer replies');
  arrangements.mockResolvedValue([{ ...item, state: 'paused', pending_events: 0, source_status: { code: 'credentials_missing', message: 'Reconnect mailbox' } }]);
  await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(container.textContent).toContain('followups.paused');
  expect(container.textContent).toContain('Reconnect mailbox');
  expect(container.textContent).not.toContain('List unavailable');
  expect(container.textContent).not.toContain('arrangements.unknownHealth');
});
it('keeps arrangements usable when source discovery fails and retries source names independently', async () => {
  const arrangements = vi.fn().mockResolvedValue([item]);
  const eventSources = vi.fn().mockRejectedValueOnce(new Error('Sources offline')).mockResolvedValue([{ extensionId: 'mail', sourceId: 'incoming', displayName: 'Recovered inbox', connections: [] }]);
  const api = { arrangements, eventSources } as unknown as ThreadFollowupsAPI;
  await act(async () => root.render(<Harness api={api} />));
  expect(container.textContent).toContain('Sources offline');
  expect(container.textContent).toContain('Watch customer replies');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(container.textContent).toContain('Recovered inbox');
  expect(container.textContent).not.toContain('Sources offline');
  expect(arrangements).toHaveBeenCalledTimes(1);
});

it('resolves source labels only within the exact remote Host connection and endpoint', async () => {
  const host = { hostId: 'remote', connectionId: 'connection', endpointIdentity: 'endpoint' };
  const remoteItem = { ...item, trigger: { ...item.trigger, source: { ...(item.trigger.kind === 'plugin_event' ? item.trigger.source : {}), host } } };
  const descriptor = { extensionId: 'mail', sourceId: 'incoming', connections: [] };
  const api = { arrangements: vi.fn().mockResolvedValue([remoteItem]), eventSources: vi.fn().mockResolvedValue([
    { ...descriptor, displayName: 'Local inbox' },
    { ...descriptor, host: { ...host, endpointIdentity: 'stale' }, displayName: 'Stale endpoint inbox' },
    { ...descriptor, host, displayName: 'Remote inbox' },
  ]) } as unknown as ThreadFollowupsAPI;
  await act(async () => root.render(<Harness api={api} />));
  expect(container.textContent).toContain('Remote inbox'); expect(container.textContent).not.toContain('Local inbox'); expect(container.textContent).not.toContain('Stale endpoint inbox');
});
