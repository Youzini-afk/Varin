import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotSummary, BotsAPI } from '@varin/application-client';
import type { VarinEvent } from '@/lib/varinEvents';
import { useCompanionAssociation } from './useCompanionAssociation';

const events = vi.hoisted(() => new Set<(event: VarinEvent) => void>());
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
  events.add(listener); return () => events.delete(listener);
} }));
const bot = (id: string, name = id): BotSummary => ({ id, name, archived: false } as BotSummary);
let root: Root;
let view: ReturnType<typeof useCompanionAssociation>;
function Harness({ api, generation = 1 }: { api: BotsAPI; generation?: number }) {
  view = useCompanionAssociation(api, generation, false);
  return <span>{view.association.botId}</span>;
}
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: vi.fn() } });
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); expect(events.size).toBe(0); vi.unstubAllGlobals(); });

it('refreshes names, archive/deletion and reconnect without opening the menu', async () => {
  let catalog = [bot('a'), bot('b')];
  const api = { list: vi.fn(async () => catalog) } as unknown as BotsAPI;
  await act(async () => root.render(<Harness api={api} />));
  await act(async () => view.choose('b'));
  expect(view.association.botId).toBe('b');
  catalog = [bot('a'), bot('b', 'Renamed')];
  await act(async () => events.forEach(listener => listener({ type: 'bot-changed', botId: 'b' })));
  expect(view.association).toMatchObject({ botId: 'b', name: 'Renamed' });
  catalog = [bot('a'), { ...bot('b'), archived: true }];
  await act(async () => events.forEach(listener => listener({ type: 'bot-changed', botId: 'b' })));
  expect(view.association.botId).toBe('a');
  catalog = [];
  await act(async () => events.forEach(listener => listener({ type: 'stream-ready' })));
  expect(view.association.route).toBe('agent-companion');
});

it('cannot restore an older catalog after an event refresh or Host switch', async () => {
  const reads: { signal: AbortSignal; resolve: (bots: BotSummary[]) => void }[] = [];
  const api = { list: (signal: AbortSignal) => new Promise<BotSummary[]>(resolve => reads.push({ signal, resolve })) } as unknown as BotsAPI;
  await act(async () => root.render(<Harness api={api} />));
  await act(async () => events.forEach(listener => listener({ type: 'bot-changed', botId: 'a' })));
  expect(reads[0]!.signal.aborted).toBe(true);
  await act(async () => reads[1]!.resolve([bot('b')]));
  await act(async () => reads[0]!.resolve([bot('a')]));
  expect(view.association.botId).toBe('b');
  await act(async () => events.forEach(listener => listener({ type: 'bot-changed', botId: 'b' })));
  await act(async () => root.render(<Harness api={api} generation={2} />));
  expect(reads[2]!.signal.aborted).toBe(true);
  await act(async () => reads[2]!.resolve([bot('stale')]));
  expect(view.association.route).toBe('unknown');
  await act(async () => reads[3]!.resolve([bot('new-host')]));
  expect(view.association.botId).toBe('new-host');
});
