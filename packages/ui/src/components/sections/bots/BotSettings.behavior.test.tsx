import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotSummary } from '@/lib/bots';
import { BotSettings } from './BotSettings';

const api = vi.hoisted(() => ({ list: vi.fn(), work: vi.fn(), update: vi.fn(), remove: vi.fn(), archive: vi.fn(), change: vi.fn() }));
vi.mock('@/lib/bots', () => ({ listBots: api.list, listBotWork: api.work, updateBot: api.update,
  deleteBot: api.remove, archiveBot: api.archive, changeBotState: api.change, createBot: vi.fn(), openBotEntryFor: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/sections/agents/ModelSelector', () => ({ ModelSelector: () => null }));
vi.mock('@/components/sections/computers/ComputerDesktopView', () => ({ ComputerDesktopView: () => null }));
vi.mock('@/lib/computers', () => ({ downloadComputerArtifact: vi.fn() }));
vi.mock('@/lib/pi-runtime/sessionNavigation', () => ({ openPiSessionFromNavigation: vi.fn() }));
vi.mock('@/components/ui/dialog', () => {
  const Section = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <section role="dialog">{children}</section> : null,
    DialogContent: Section, DialogHeader: Section, DialogFooter: Section, DialogTitle: Section, DialogDescription: Section };
});
vi.mock('./BotMenu', () => ({ BotMenu: ({ bot, onAction, children }: { bot: BotSummary; onAction(action: string): void; children: React.ReactNode }) => <div>{children}
  {['rename', 'archive', 'restore', 'delete'].map((action) => <button key={action} onClick={() => onAction(action)}>{action}-{bot.id}</button>)}
</div> }));
vi.mock('./BotNameDialog', () => ({ BotNameDialog: ({ open, onNameChange, onSubmit }: { open: boolean; onNameChange(name: string): void; onSubmit(event: React.FormEvent<HTMLFormElement>): void }) => open ? <form onSubmit={onSubmit}>
  <button type="button" onClick={() => onNameChange('New name')}>set-name</button><button type="submit">save-name</button>
</form> : null }));

const bot = (id: string, archived = false): BotSummary => ({ id, name: id, archived, homeDir: `/bots/${id}`,
  coordinatorHostId: 'host', entrySessionId: null, instructions: null, model: null, createdAt: '', updatedAt: '' });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Event', window.Event); vi.stubGlobal('CustomEvent', window.CustomEvent);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  api.list.mockReset().mockResolvedValue([bot('a'), bot('b', true)]);
  api.work.mockReset().mockResolvedValue([]); api.update.mockReset().mockResolvedValue(bot('a'));
  api.archive.mockReset().mockResolvedValue(bot('a', true)); api.change.mockReset().mockResolvedValue(bot('b'));
  api.remove.mockReset().mockResolvedValue(null);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => { root.render(<BotSettings />); }); };
const click = async (text: string) => {
  const button = [...(container.querySelector('[role=dialog]') ?? container).querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button).toBeTruthy(); await act(async () => { button!.click(); });
};

it('connects list rename/archive/restore to the right Bot without changing the selected profile', async () => {
  api.list.mockResolvedValue([bot('a'), bot('b')]);
  await render(); await click('rename-b'); await click('set-name');
  await act(async () => { container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.update).toHaveBeenCalledWith('b', { name: 'New name' });
  expect(container.querySelector('[aria-current=page]')?.textContent).toBe('a');
  await click('archive-a'); expect(api.archive).toHaveBeenCalledWith('a');
  await click('restore-b'); expect(api.change).toHaveBeenCalledWith('b', 'restore');
});

it('requires confirmation, keeps request failures retryable and selects the remaining Bot after deletion', async () => {
  await render(); await click('delete-a');
  expect(api.remove).not.toHaveBeenCalled();
  api.remove.mockRejectedValueOnce(new Error('Host offline'));
  await click('settings.bots.delete');
  expect(container.querySelector('[role=dialog] [role=alert]')?.textContent).toBe('Host offline');
  api.list.mockResolvedValue([bot('b', true)]);
  await click('settings.bots.delete');
  expect(api.remove).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role=dialog]')).toBeNull();
  expect(container.querySelector('[aria-current=page]')?.textContent).toContain('b');
});

it('shows pending cleanup and exposes retry when an archived Bot deletion fails', async () => {
  const failed = { ...bot('b', true), deletion: { operationId: 'delete-b', error: 'File busy' } };
  api.list.mockResolvedValue([failed]);
  await render();
  expect(container.querySelector('[role=status]')?.textContent).toContain('settings.bots.deleteFailed');
  const deleting = { ...failed, deletion: { ...failed.deletion, error: null } };
  api.change.mockResolvedValue(deleting); api.list.mockResolvedValue([deleting]);
  await click('settings.bots.deleteRetry');
  expect(api.change).toHaveBeenCalledWith('b', 'retry');
  expect(container.querySelector('[role=status]')?.textContent).toContain('settings.bots.deleting');
});
