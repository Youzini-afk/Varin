import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { BotHandoffDialog } from './BotHandoffDialog';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';

const f = vi.hoisted(() => ({ list: vi.fn(), sessions: vi.fn(), snapshot: vi.fn(), submit: vi.fn(), enqueue: vi.fn(), matters: vi.fn(), open: vi.fn(), switchProfile: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => {
  const apis = { bots: { list: f.list, sessions: { list: f.sessions }, matters: { update: f.matters } }, threads: { snapshot: f.snapshot, submit: f.submit, enqueue: f.enqueue } };
  return { useRuntimeAPIs: () => apis };
});
vi.mock('@/lib/bots', () => ({ useBotNavigation: { getState: () => ({ botId: 'one' }) }, openBotConversation: f.open }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: f.switchProfile }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>, DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>, DialogFooter: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
}));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange, ...props }: React.PropsWithChildren<{ value: string; disabled: boolean; onValueChange(value: string): void }>) => <select {...props} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));
const identity = { runtime: 'agent' as const, threadId: 'ordinary-task', branchId: 'current-route' };
let root: Root, container: HTMLDivElement;
const receiving = { runtime: 'agent', threadId: 'two-second-session', branchId: 'two-second-route' };
beforeEach(() => {
  vi.clearAllMocks(); useThreadDraftStore.setState({ drafts: {} }); useMessageQueueStore.setState({ botFollowUpBehavior: 'steer' });
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  f.list.mockResolvedValue(['one', 'two'].map(id => ({ id, name: id, model: { providerId: 'chosen-provider', modelId: 'chosen-model', thinkingLevel: 'high' } })));
  f.sessions.mockImplementation(async bot => [1, 2].map(n => ({ identity: n === 2 && bot === 'two' ? receiving : { runtime: 'agent', threadId: `${bot}-${n}`, branchId: `${bot}-${n}-route` }, thread: { title: `Conversation ${n}` } })));
  f.snapshot.mockResolvedValue({ thread: { bot_id: 'two', branches: [{ branch_id: receiving.branchId, head: 'existing-head', active_run_id: null }] }, modelSelection: {} });
  f.submit.mockResolvedValue({ input_id: 'accepted-input', run_id: 'accepted-run' }); f.enqueue.mockResolvedValue({ input_id: 'queued-input' });
  f.open.mockResolvedValue(undefined); f.switchProfile.mockResolvedValue(undefined);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function choose(label: string, value: string) {
  const input = container.querySelectorAll<HTMLSelectElement>('select')[label === 'bot.handoff.bot' ? 0 : 1]!;
  Object.defineProperty(input, 'value', { configurable: true, value });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
}
async function prepare() {
  await act(async () => root.render(<BotHandoffDialog identity={identity} onClose={() => {}} />));
  await choose('bot.handoff.bot', 'two'); await choose('bot.handoff.session', receiving.threadId);
  const textarea = container.querySelector('textarea')!;
  textarea.value = '只审查这项工作的方案，先别改文件。';
  await act(async () => textarea.dispatchEvent(new window.Event('input', { bubbles: true })));
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === label)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
it('starts blank and sends user text plus a source reference to the specifically selected Bot conversation', async () => {
  await act(async () => root.render(<BotHandoffDialog identity={identity} onClose={() => {}} />));
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(f.snapshot).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.matters).not.toHaveBeenCalled();
  await prepare(); await click('bot.handoff.send');
  const input = f.submit.mock.calls[0]![0];
  expect(input).toMatchObject({ ...receiving, expectedHead: 'existing-head', model: { modelId: 'chosen-model', thinkingLevel: 'high' },
    text: '只审查这项工作的方案，先别改文件。\n\n@bot.handoff.source', references: [{ kind: 'thread', threadId: identity.threadId, branchId: identity.branchId }] });
  expect(input.text.slice(input.references[0].start, input.references[0].end)).toBe('@bot.handoff.source');
  expect(f.open).toHaveBeenCalledWith('two', receiving); expect(f.matters).not.toHaveBeenCalled();
});
it('retains an uncertain send across dismissal and retries the same message and recipient', async () => {
  f.submit.mockRejectedValueOnce(new Error('Connection lost'));
  await prepare(); await click('bot.handoff.send'); const original = f.submit.mock.calls[0]![0];
  await act(async () => root.render(null));
  await act(async () => root.render(<BotHandoffDialog identity={identity} onClose={() => {}} />));
  expect(container.querySelector('textarea')?.disabled).toBe(true);
  await click('composer.menu.retry');
  expect(f.submit.mock.calls[1]![0]).toEqual(original); expect(f.snapshot).toHaveBeenCalledOnce();
});
it.each(['steer', 'queue'] as const)('uses the receiving Bot input behavior %s when it is working', async behavior => {
  useMessageQueueStore.setState({ botFollowUpBehavior: behavior });
  f.snapshot.mockResolvedValue({ thread: { bot_id: 'two', branches: [{ branch_id: receiving.branchId, head: 'head', active_run_id: 'running' }] }, modelSelection: {} });
  await prepare(); await click('bot.handoff.send');
  expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ...receiving, mode: behavior === 'queue' ? 'next_run' : 'boundary' }));
  expect(f.submit).not.toHaveBeenCalled(); expect(f.matters).not.toHaveBeenCalled();
});
