import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyBotOrganizationChange, type BotOrganization, type BotOrganizationChange, type BotSummary } from '@varin/application-client';
import { useBotOrganization } from './useBotOrganization';
import { BotOrganizationList } from './BotOrganizationList';
import { BotOrganizationDialog, type BotOrganizationDialogState } from './BotOrganizationDialog';
import { useBotLayout } from './botLayout';

const state = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn(), listeners: new Set<(event: { type: 'bot-organization-changed' }) => void>() }));
vi.mock('@/hooks/useRuntimeAPIs', () => { const bots = { organization: { read: state.read, update: state.update } }; return { useRuntimeAPIs: () => ({ bots }) }; });
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: { type: 'bot-organization-changed' }) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./BotGroupMenu', () => ({ BotGroupMenu: ({ children }: React.PropsWithChildren) => <>{children}</> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/dialog', () => {
  const Children = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return { Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: Children, DialogHeader: Children, DialogTitle: Children, DialogDescription: Children, DialogFooter: Children };
});

const bots = ['researcher', 'writer'].map(id => ({ id, name: id, pinnedAt: null } as BotSummary));
const original: BotOrganization = { revision: 2, groups: [{ id: 'research', name: 'Research', botIds: ['researcher'] }], ungrouped: ['writer'] };
function Harness({ query = '' }: { query?: string }) {
  const organization = useBotOrganization(bots);
  const [dialog, setDialog] = React.useState<BotOrganizationDialogState | null>(null);
  return <>
    <button onClick={() => setDialog({ kind: 'create' })}>create</button>
    <button onClick={() => { void organization.change({ kind: 'move-bot', botId: 'writer', groupId: 'research', beforeId: 'researcher' }); }}>move-writer</button>
    <BotOrganizationList bots={bots} organization={organization} selectedId="researcher" query={query} scope="test-host" onDialog={setDialog} renderBot={bot => <span data-bot={bot.id}>{bot.name}</span>} />
    <BotOrganizationDialog value={dialog} organization={organization} onClose={() => setDialog(null)} />
    {organization.error && <p role="alert">{organization.error}</p>}
  </>;
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('Node', window.Node); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  state.listeners.clear(); state.read.mockReset().mockResolvedValue(structuredClone(original)); state.update.mockReset();
  useBotLayout.setState({ navigatorFolded: {} });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (query = '') => { await act(async () => root.render(<Harness query={query} />)); };
const click = async (label: string) => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === label)!; expect(button).toBeTruthy(); await act(async () => button.click()); };

it('remembers group collapse across remounts and only temporarily expands during search', async () => {
  await render();
  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => toggle().click()); expect(toggle().getAttribute('aria-expanded')).toBe('false');
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  await render('Research'); expect(toggle().getAttribute('aria-expanded')).toBe('true');
  await act(async () => toggle().click()); expect(toggle().getAttribute('aria-expanded')).toBe('false');
  await render('Res'); expect(toggle().getAttribute('aria-expanded')).toBe('true');
  await render(); expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(state.update).not.toHaveBeenCalled();
});

it('optimistically moves a Bot, restores the authoritative order on failure, and observes another client', async () => {
  await render(); let fail!: (error: Error) => void;
  state.update.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
  await click('move-writer');
  const order = () => [...container.querySelectorAll('[data-bot]')].map(element => element.getAttribute('data-bot'));
  expect(order()).toEqual(['writer', 'researcher']);
  expect(container.querySelector('.bot-folder [data-bot="writer"]')).not.toBeNull();
  expect(state.update).toHaveBeenCalledWith({ expectedRevision: 2, change: { kind: 'move-bot', botId: 'writer', groupId: 'research', beforeId: 'researcher' } });
  await act(async () => fail(new Error('Offline')));
  expect(container.querySelector('.bot-folder [data-bot="writer"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Offline');
  state.read.mockResolvedValue({ ...original, revision: 3, groups: [{ ...original.groups[0], name: 'Renamed remotely' }] });
  await act(async () => { for (const listener of state.listeners) listener({ type: 'bot-organization-changed' }); });
  expect(container.textContent).toContain('Renamed remotely');
});

it('creates a named group from the dialog and retains its draft after a failed save', async () => {
  await render(); await click('create');
  const input = container.querySelector('input')!;
  await act(async () => { input.value = 'Writing'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  state.update.mockRejectedValueOnce(new Error('Not saved'));
  const submit = async () => { await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); };
  await submit(); expect(container.querySelector('input')?.value).toBe('Writing');
  const change = state.update.mock.calls[0]![0].change as BotOrganizationChange;
  expect(change).toMatchObject({ kind: 'create', name: 'Writing' });
  state.update.mockResolvedValue({ ...applyBotOrganizationChange(original, change, bots.map(bot => bot.id)), revision: 3 });
  await submit(); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).toContain('Writing');
});
