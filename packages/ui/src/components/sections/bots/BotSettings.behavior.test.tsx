import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotSummary } from '@/lib/bots';
import { BotSettings } from './BotSettings';
import { BotDetailsDialog } from './BotDetailsDialog';

const api = vi.hoisted(() => ({ list: vi.fn(), memory: vi.fn(), update: vi.fn(), remove: vi.fn(), archive: vi.fn(), change: vi.fn(), organizationRead: vi.fn(), organizationUpdate: vi.fn() }));
vi.mock('@/hooks/useRuntimeAPIs', () => { const bots = { organization: { read: api.organizationRead, update: api.organizationUpdate } }; return { useRuntimeAPIs: () => ({ bots }) }; });
vi.mock('@/lib/bots', async original => ({ ...await original<typeof import('@/lib/bots')>(), listBots: api.list, updateBot: api.update,
  listBotMemory: api.memory, deleteBot: api.remove, archiveBot: api.archive, changeBotState: api.change, createBot: vi.fn(), openBotEntryFor: vi.fn() }));
vi.mock('@/components/ui/VarinLogo', () => ({ VarinLogo: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Children = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return { DropdownMenu: Children, DropdownMenuContent: Children, DropdownMenuTrigger: Children, DropdownMenuItem: Children };
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./BotModelSelector', () => ({ BotModelSelector: ({ onChange, onThinkingChange }: { onChange(provider: string, model: string): Promise<void>; onThinkingChange(level: 'high'): void }) => <><button onClick={() => { void onChange('gateway', 'claude'); }}>choose-model</button><button onClick={() => onThinkingChange('high')}>choose-thinking</button></> }));
vi.mock('./BotAppearanceSettings', () => ({ BotAppearanceSettings: ({ onApply }: { onApply(value: BotSummary['appearance']): void }) => <button onClick={() => onApply({ kind: 'preset', character: 'gpt', color: 'original' })}>choose-appearance</button> }));
vi.mock('../shared/kit', async original => ({
  ...await original<typeof import('../shared/kit')>(),
  Field: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} />,
  Area: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} />,
}));
vi.mock('@/components/ui/dialog', () => {
  const Section = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Dialog: ({ open, children, onOpenChange }: { open: boolean; children: React.ReactNode; onOpenChange?(open: boolean): void }) => open ? <section role="dialog">{children}<button onClick={() => onOpenChange?.(false)}>close-dialog</button></section> : null,
    DialogContent: Section, DialogHeader: Section, DialogFooter: Section, DialogTitle: Section, DialogDescription: Section };
});
vi.mock('./BotMenu', () => ({ BotMenu: ({ bot, onAction, children }: { bot: BotSummary; onAction(action: string): void; children: React.ReactNode }) => <div>{children}
  {['rename', 'archive', 'restore', 'delete'].map((action) => <button key={action} onClick={() => onAction(action)}>{action}-{bot.id}</button>)}
</div> }));
vi.mock('./BotNameDialog', () => ({ BotNameDialog: ({ open, name, onNameChange, onSubmit }: { open: boolean; name: string; onNameChange(name: string): void; onSubmit(name: string): void }) => open ? <form onSubmit={event => { event.preventDefault(); onSubmit(name.trim()); }}>
  <button type="button" onClick={() => onNameChange('New name')}>set-name</button><button type="submit">save-name</button>
</form> : null }));

const bot = (id: string, archived = false): BotSummary => ({ revision: 1, id, name: id, archived, homeDir: `/bots/${id}`,
  coordinatorHostId: 'host', entry: { runtime: 'agent', threadId: `thread:${id}`, branchId: `branch:${id}` }, instructions: null, model: null, createdAt: '', updatedAt: '' });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  window.confirm = vi.fn(() => true);
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Event', window.Event); vi.stubGlobal('CustomEvent', window.CustomEvent);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  api.list.mockReset().mockResolvedValue([bot('a'), bot('b', true)]);
  api.update.mockReset().mockResolvedValue(bot('a'));
  api.memory.mockReset().mockResolvedValue([]);
  api.archive.mockReset().mockResolvedValue(bot('a', true)); api.change.mockReset().mockResolvedValue(bot('b'));
  api.remove.mockReset().mockResolvedValue(null);
  api.organizationRead.mockReset().mockResolvedValue({ revision: 0, groups: [], ungrouped: [] });
  api.organizationUpdate.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('uses the Host grouping and member order, with archived Bots collapsed', async () => {
  api.list.mockResolvedValue([bot('a'), bot('b'), bot('c', true)]);
  api.organizationRead.mockResolvedValue({ revision: 1, groups: [{ id: 'research', name: 'Research', botIds: ['b', 'a'] }], ungrouped: ['c'] });
  await render();
  expect(container.textContent).toContain('Research');
  expect([...container.querySelectorAll('.sk-ci')].map(button => button.textContent)).toEqual(['b', 'a']);
  await click('b');
  expect(container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')?.value).toBe('b');
  await click('settings.bots.archived');
  expect([...container.querySelectorAll('.sk-ci')].map(button => button.textContent)).toEqual(['b', 'a', 'c']);
});
const render = async () => { await act(async () => { root.render(<BotSettings />); }); };
const click = async (text: string) => {
  const button = [...(container.querySelector('[role=dialog]') ?? container).querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button).toBeTruthy(); await act(async () => { button!.click(); });
};

it('marks thinking-only changes as dirty and saves them with the profile', async () => {
  const model = { providerId: 'gateway', modelId: 'claude' };
  api.list.mockResolvedValue([{ ...bot('a'), model }]);
  await render();
  await click('choose-thinking');
  await click('settings.bots.save');
  expect(api.update).toHaveBeenCalledWith('a', expect.objectContaining({ model: { ...model, thinkingLevel: 'high' } }));
});

it('switches Bots in the directory and applies lifecycle actions to the selected Bot', async () => {
  api.list.mockResolvedValue([bot('a'), bot('b')]);
  await render(); await click('b');
  expect(container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')?.value).toBe('b');
  await click('a');
  api.list.mockResolvedValue([bot('a', true), bot('b', true)]);
  await click('archive-a'); expect(api.archive).toHaveBeenCalledWith('a');
  await click('b');
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
  expect(container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')?.value).toBe('b');
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


it('saves name, appearance, instructions and model as one profile draft', async () => {
  let current = bot('a');
  api.list.mockImplementation(async () => [current]);
  let acknowledge!: () => void;
  const pending = new Promise<void>(resolve => { acknowledge = resolve; });
  api.update.mockImplementation(async (_id, patch) => { await pending; current = { ...current, ...patch }; return current; });
  await render();
  const name = container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')!;
  const instructions = container.querySelector<HTMLTextAreaElement>('[aria-label="settings.bots.instructions.label"]')!;
  await act(async () => { name.value = 'Unsaved name'; name.dispatchEvent(new Event('input', { bubbles: true })); instructions.value = 'Unsaved instructions'; instructions.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('choose-model');
  await click('choose-appearance');
  expect(api.update).not.toHaveBeenCalled();
  expect(name.value).toBe('Unsaved name');
  expect(instructions.value).toBe('Unsaved instructions');
  await click('settings.bots.save');
  expect(api.update).toHaveBeenCalledExactlyOnceWith('a', { name: 'Unsaved name', instructions: 'Unsaved instructions', model: { providerId: 'gateway', modelId: 'claude' },
    appearance: { kind: 'preset', character: 'gpt', color: 'original' } });
  const visibleStatus = () => container.querySelector('[aria-hidden="false"] [role="status"]')?.textContent;
  expect(visibleStatus()).toBe('settings.common.actions.saving');
  await act(async () => acknowledge());
  expect(visibleStatus()).toBe('settings.common.status.saved');

  // A new edit interrupts the brief acknowledgement. Discarding it isn't another save.
  await act(async () => { name.value = 'Another draft'; name.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(visibleStatus()).toBe('assistant.unsaved');
  await click('settings.kit.discard');
  expect(name.value).toBe('Unsaved name');
  expect(visibleStatus()).toBeUndefined();
  expect(api.update).toHaveBeenCalledOnce();
});

it('opens memory in place, keeps drafts across tabs, and guards changing Bots', async () => {
  api.memory.mockResolvedValue([{ id: 1, content: 'Remember this', trigger: '', inactive: false }]);
  await render();
  expect(api.memory).not.toHaveBeenCalled();
  const name = container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')!;
  await act(async () => { name.value = 'Draft'; name.dispatchEvent(new Event('input', { bubbles: true })); });
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await click('settings.bots.archived'); await click('b');
  expect(name.value).toBe('Draft');
  expect(window.confirm).toHaveBeenCalledWith('settings.bots.discardConfirm');
  await click('assistant.memory.title');
  expect(container.querySelector('[role=dialog]')).toBeNull();
  await click('settings.bots.memory.correct');
  const memory = container.querySelector<HTMLTextAreaElement>('[aria-label="settings.bots.memory.correct"]')!;
  await act(async () => { memory.value = 'Memory draft'; memory.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('bot.profile.title');
  expect(name.value).toBe('Draft');
  await click('assistant.memory.title');
  expect(memory.value).toBe('Memory draft');
  expect(api.memory).toHaveBeenCalledTimes(1);
});

it('keeps a failed profile save editable and cancels back to the saved profile', async () => {
  await render();
  const name = container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')!;
  await act(async () => { name.value = 'Draft'; name.dispatchEvent(new Event('input', { bubbles: true })); });
  api.update.mockRejectedValueOnce(new Error('Save unavailable'));
  await click('settings.bots.save');
  expect(name.value).toBe('Draft');
  expect(container.textContent).toContain('Save unavailable');
  await click('settings.kit.discard');
  expect(name.value).toBe('a');
  expect(api.update).toHaveBeenCalledOnce();
});

it('guards unsaved standalone Bot profile dialog dismissal without a settings navigation host', async () => {
  const onClose = vi.fn();
  await act(async () => { root.render(<BotDetailsDialog bot={{ id: 'a', name: 'a', tab: 'profile' }} onClose={onClose} />); });
  const name = container.querySelector<HTMLInputElement>('[aria-label="settings.bots.name.label"]')!;
  await act(async () => { name.value = 'Unsaved dialog name'; name.dispatchEvent(new Event('input', { bubbles: true })); });
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await click('close-dialog');
  expect(onClose).not.toHaveBeenCalled();
  expect(name.value).toBe('Unsaved dialog name');
  expect(window.confirm).toHaveBeenCalledWith('settings.bots.discardConfirm');
  vi.mocked(window.confirm).mockReturnValueOnce(true);
  await click('close-dialog');
  expect(onClose).toHaveBeenCalledOnce();
});
