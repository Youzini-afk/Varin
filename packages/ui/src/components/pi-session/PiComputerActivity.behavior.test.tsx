import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputerActivityEntry } from '@varin/protocol';
import type { VarinEvent } from '@/lib/varinEvents';
import { PiComputerActivity } from './PiComputerActivity';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), open: vi.fn(), listeners: new Set<(event: VarinEvent) => void>(),
}));
vi.mock('@/lib/computers', () => ({ readComputerActivity: mocks.read }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ openContextPanelTab: mocks.open }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
  mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); };
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  mocks.read.mockReset(); mocks.open.mockReset(); mocks.listeners.clear(); vi.unstubAllGlobals();
});

it('keeps newer activity over a delayed snapshot, opens the existing desktop tab, and follows session ownership', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  let finishRead!: (value: ComputerActivityEntry[]) => void;
  mocks.read.mockReturnValue(new Promise<ComputerActivityEntry[]>(resolve => { finishRead = resolve; }));
  await act(async () => { root = createRoot(container); root.render(<PiComputerActivity sessionId="s1" directory="/repo" />); });
  const entry: ComputerActivityEntry = { desktopId: 'desktop-1', activity: { sessionId: 's1', app: 'Editor', operation: 'click', status: 'running', updatedAt: 'now' } };
  const emit = async (event: VarinEvent) => act(async () => { for (const listener of mocks.listeners) listener(event); });
  await emit({ type: 'computer-activity', ...entry });
  await act(async () => finishRead([]));
  expect(container.textContent).toContain('Editor');
  expect(container.textContent).toContain('chat.computerActivity.working');
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.open).toHaveBeenCalledWith('/repo', { mode: 'computer', targetPath: 'desktop-1', dedupeKey: 'desktop:desktop-1', label: 'Editor' });
  await emit({ type: 'computer-activity', ...entry, activity: { ...entry.activity, sessionId: 'other', status: 'idle' } });
  expect(container.querySelector('button')).toBeNull();
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.read.mockResolvedValue([{ ...entry, activity: { ...entry.activity, status: 'idle' } }]);
  await emit({ type: 'stream-ready' });
  expect(container.textContent).toContain('chat.computerActivity.view');
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
