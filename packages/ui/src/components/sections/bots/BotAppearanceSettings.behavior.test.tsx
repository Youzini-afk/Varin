import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotAppearanceAsset, BotSummary } from '@varin/application-client';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { BotAppearanceSettings } from './BotAppearanceSettings';

const api = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), remove: vi.fn() }));
const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'zh-CN' }));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => {
    if (!key.startsWith('bot.appearance.character.')) return key;
    const labels = locale.current === 'en' ? en : zhCN;
    return labels[key as keyof typeof labels] ?? key;
  } }),
}));
vi.mock('@/lib/bots', () => ({ updateBot: api.update }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/workbenches/bot/botAppearanceResources', () => ({ botAppearanceAPI: () => api }));
vi.mock('@/workbenches/bot/BotImageArtwork', () => ({ BotImageArtwork: () => null }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ useMotionLevel: () => 'off' }));
vi.mock('@/workbenches/bot/BotFigure', () => ({
  BotFigure: ({ appearance, onReady }: { appearance?: BotSummary['appearance']; onReady?(ready: boolean): void }) => {
    React.useEffect(() => onReady?.(true), [appearance, onReady]); return null;
  },
  BotPresetPortrait: () => null,
}));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>, motion: { div: ({ children }: React.PropsWithChildren) => <div>{children}</div> } }));
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: Part, DialogHeader: Part, DialogFooter: Part, DialogTitle: Part, DialogDescription: Part };
});
const bot: BotSummary = { id: 'one', name: 'One', revision: 2, archived: false, instructions: 'Unchanged', model: null,
  homeDir: '', coordinatorHostId: '', entry: { runtime: 'agent', threadId: 'thread', branchId: 'main' }, createdAt: '', updatedAt: '' };
const media = { hash: 'b'.repeat(64), poster: 'b'.repeat(64), mime: 'image/png', width: 100, height: 100, animated: false };
const asset: BotAppearanceAsset = { id: 'a'.repeat(64), name: 'Moon', image: media, portrait: media, states: {}, transparent: true };
let root: Root, container: HTMLElement;
beforeEach(() => {
  locale.current = 'en';
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  api.list.mockReset().mockResolvedValue([asset]); api.update.mockReset().mockImplementation(async (_id, patch) => ({ ...bot, ...patch, revision: 3 }));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const click = async (label: string) => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === label)!; expect(button).toBeTruthy(); await act(async () => button.click()); };
it('saves a built-in character by ID and restores its selection with the current language', async () => {
  await act(async () => root.render(<BotAppearanceSettings bot={bot} />));
  await click('bot.appearance.change'); await click('Scarlet');
  expect(api.update).not.toHaveBeenCalled();
  await click('bot.appearance.apply');
  expect(api.update).toHaveBeenCalledWith('one', { appearance: { kind: 'preset', character: 'mistral', color: 'original' } });
  locale.current = 'zh-CN';
  await click('bot.appearance.change');
  expect([...container.querySelectorAll('button[aria-pressed=true]')].map(button => button.textContent)).toContain('赤翎');
  expect([...container.querySelectorAll('button')].map(button => button.textContent)).toContain('薇琳');
});
it('previews a selected image without saving, applies only its appearance, and leaves profile drafts alone', async () => {
  const changed = vi.fn(); await act(async () => root.render(<BotAppearanceSettings bot={bot} onChanged={changed} />));
  await click('bot.appearance.change'); await click('Moon');
  expect(api.update).not.toHaveBeenCalled();
  await click('bot.appearance.apply');
  expect(api.update).toHaveBeenCalledWith('one', { appearance: { kind: 'custom', assetId: asset.id, portrait: { x: .5, y: .5, scale: 1 }, figure: { x: .5, y: .5, scale: 1 } } });
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'Unchanged', appearance: expect.objectContaining({ assetId: asset.id }) }));
  expect(container.querySelector('[role=dialog]')).toBeNull();
});
it('cancel keeps the saved appearance; a save error keeps the selected image available to retry', async () => {
  await act(async () => root.render(<BotAppearanceSettings bot={bot} />));
  await click('bot.appearance.change'); await click('Moon'); await click('settings.common.actions.cancel');
  expect(api.update).not.toHaveBeenCalled();
  await click('bot.appearance.change'); await click('Moon');
  api.update.mockRejectedValueOnce(new Error('Host offline')); await click('bot.appearance.apply');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Host offline');
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Moon')?.getAttribute('aria-pressed')).toBe('true');
  await click('bot.appearance.apply'); expect(container.querySelector('[role=dialog]')).toBeNull();
});
