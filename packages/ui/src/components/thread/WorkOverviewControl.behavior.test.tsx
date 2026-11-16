import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkOverviewControl } from './WorkOverviewControl';
import type { WorkOverviewView } from './workOverviewMotion';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';

const preference = vi.hoisted(() => ({ level: 'full' as 'full' | 'reduced' | 'off' }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ useMotionLevel: () => preference.level }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

let root: Root;
let host: HTMLElement;
let time: number;
let callbacks: Map<number, FrameRequestCallback>;
let observations: Set<() => void>;
let geometry: { width: number; height: number; compact: number; full: number; axis: string };

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  preference.level = 'full';
  useWorkOverviewStore.setState({ panelWidth: 280 });
  geometry = { width: 1000, height: 720, compact: 220, full: 610, axis: 'width' };
  time = 0; callbacks = new Map(); observations = new Set();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { observations.add(callback); }
    observe() {}
    disconnect() { observations.delete(this.callback); }
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) =>
    key === '--overview-axis' ? geometry.axis : key === '--wb-overview-compact-width' ? '240px' : '' }));
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get() { return geometry.width; } },
    clientHeight: { configurable: true, get() { return geometry.height; } },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const natural = this.hasAttribute('data-harness-overview-panel') ? geometry.full : geometry.compact;
    const height = this.hidden ? 0 : Math.min(natural, Number.parseFloat(this.style.maxHeight) || Infinity);
    const width = Number.parseFloat(this.style.width) || geometry.width;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} } as DOMRect;
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(observations.size).toBe(0);
  expect(callbacks.size).toBe(0);
  host.remove(); vi.unstubAllGlobals();
});

const render = (view: WorkOverviewView) => act(async () => root.render(
  <div className="thread-conversation-layout">
    <div className="thread-conversation-main"><div className="thread-conversation-content">Conversation</div></div>
    <WorkOverviewControl open={view === 'full'} compactOpen={view === 'compact'} attention={false}
      onOpenChange={() => {}} onCompactChange={() => {}} onSelect={() => {}} rows={[]}
      compactContent={<p>Current work</p>}><textarea defaultValue="Plan draft" /></WorkOverviewControl>
  </div>,
));
const advance = (milliseconds: number) => act(async () => {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    time += 16;
    const frame = [...callbacks.values()]; callbacks.clear();
    for (const callback of frame) callback(time);
  }
});
const aside = () => host.querySelector<HTMLElement>('aside')!;
const frame = () => host.querySelector<HTMLElement>('[data-overview-frame]')!;
const full = () => host.querySelector<HTMLElement>('[data-harness-overview-panel]')!;
const compact = () => host.querySelector<HTMLElement>('[data-harness-overview-peek]')!;
const main = () => host.querySelector<HTMLElement>('.thread-conversation-main')!;

it('keeps the closing surface painted and reverses without resetting its geometry or editor', async () => {
  await render('closed'); await advance(16);
  await render('full');
  expect(frame().hidden).toBe(false);
  expect(aside().style.width).toBe('0px');
  expect(main().style.getPropertyValue('--overview-reading-width')).toBe('704px');
  await advance(96);
  geometry.width = 920;
  for (const callback of observations) callback();
  await advance(16);
  expect(main().style.getPropertyValue('--overview-reading-width')).toBe('624px');
  const current = aside().style.width;
  expect(Number.parseFloat(current)).toBeGreaterThan(0);
  expect(Number.parseFloat(current)).toBeLessThan(296);
  const editor = host.querySelector('textarea')!;
  editor.value = 'Unsaved work'; full().querySelector('.thread-work-overview')!.scrollTop = 77;
  await render('closed');
  expect(aside().style.width).toBe(current);
  expect(frame().hidden).toBe(false);
  expect(frame().hasAttribute('inert')).toBe(true);
  await advance(1200);
  expect(frame().hidden).toBe(true);
  expect(aside().style.width).toBe('0px');
  expect(main().hasAttribute('data-overview-gliding')).toBe(false);
  await render('full'); await advance(1200);
  expect(host.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('Unsaved work');
  expect(full().querySelector('.thread-work-overview')!.scrollTop).toBe(77);
});

it('morphs the same card between full and compact, keeping both faces until the handoff settles', async () => {
  await render('full'); await advance(16);
  const card = frame();
  await render('compact');
  expect(frame()).toBe(card);
  expect(full().hidden).toBe(false);
  expect(full().hasAttribute('inert')).toBe(true);
  expect(compact().hidden).toBe(false);
  await advance(112);
  const height = frame().style.height;
  expect(Number.parseFloat(height)).toBeGreaterThan(222);
  expect(Number.parseFloat(height)).toBeLessThan(612);
  await render('full');
  expect(frame().style.height).toBe(height);
  await advance(1200);
  expect(frame()).toBe(card);
  expect(frame().style.height).toBe('612px');
  expect(full().hidden).toBe(false);
  expect(compact().hidden).toBe(true);
});

it('reserves vertical space on narrow layouts and follows changed content and available height', async () => {
  geometry.axis = 'height'; geometry.width = 540;
  await render('closed'); await advance(16);
  await render('compact'); await advance(112);
  expect(aside().style.width).toBe('100%');
  expect(Number.parseFloat(aside().style.height)).toBeGreaterThan(0);
  expect(main().hasAttribute('data-overview-gliding')).toBe(false);
  geometry.compact = 330;
  for (const callback of observations) callback();
  await advance(1200);
  expect(aside().style.height).toBe('348px');
  geometry.height = 400;
  for (const callback of observations) callback();
  await advance(1200);
  expect(aside().style.height).toBe('200px');
  expect(frame().style.height).toBe('184px');
});

it('finishes an in-flight movement immediately when the user switches motion off', async () => {
  await render('closed'); await advance(16);
  await render('full'); await advance(80);
  preference.level = 'off';
  await render('full');
  expect(aside().style.width).toBe('296px');
  expect(frame().style.height).toBe('612px');
  expect(aside().hasAttribute('data-overview-motion')).toBe(false);
  expect(main().hasAttribute('data-overview-gliding')).toBe(false);
});

it('honors reduced motion with an opacity-only departure at the original card size', async () => {
  preference.level = 'reduced';
  await render('full'); await advance(16);
  await render('closed');
  expect(aside().style.width).toBe('0px');
  expect(frame().style.width).toBe('280px');
  expect(frame().style.height).toBe('612px');
  expect(frame().style.translate).toBe('');
  expect(frame().hidden).toBe(false);
  await advance(1200);
  expect(frame().hidden).toBe(true);
});
