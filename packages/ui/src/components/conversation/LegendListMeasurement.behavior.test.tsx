import { createRequire } from 'node:module';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react';
import type { ThreadHistoryItem, ThreadsAPI } from '@varin/application-client';
import { ConversationTimeline } from './ConversationTimeline';
import { useTimelineViewStore } from './timelineViewStore';
import { useUIStore } from '@/stores/useUIStore';

// Exercise both shipped /react exports, not a copy of the measurement algorithm.
const require = createRequire(import.meta.url);
const cjs = require('@legendapp/list/react') as { LegendList: typeof LegendList };

// Keep the real timeline, virtual list, core message rows, Markdown and chrome.
// External owners and optional navigation/media are outside this measurement contract.
vi.mock('./ChatTurnNavigator', () => ({ ChatTurnNavigator: () => null }));
vi.mock('@/components/thread/ThreadContent', () => ({ ThreadContent: () => null }));
vi.mock('@/components/thread/ThreadSkillMaterials', () => ({ ThreadSkillMaterials: () => null }));
vi.mock('@/components/thread/ReviewTransferActions', () => ({ ReviewTransferActions: () => null }));
vi.mock('@/components/thread/ThreadMedia', () => ({ ThreadMedia: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/extensions/workbench-registry', () => {
  const renderers: [] = [];
  return { useWorkbenchMatchRenderers: () => renderers };
});
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeKey: () => 'measurement-fixture-host', getRuntimeEndpointGeneration: () => 1,
}));

let hidden: boolean, rowHeight: number, zeroRow: string | undefined, zeroPrefix: number;
let root: Root, mount: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>, nextFrame: number, time: number;
// LegendList retains a shared observer, so preserve its instance across tests while targets unmount.
const observers: LayoutObserver[] = [];
class LayoutObserver {
  targets = new Set<Element>();
  constructor(readonly callback: (entries: Pick<ResizeObserverEntry, 'target' | 'contentRect'>[]) => void) {
    observers.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
}
const notifyResize = () => act(async () => {
  for (const observer of observers) observer.callback([...observer.targets]
    .filter(target => target.isConnected)
    .map(target => ({ target, contentRect: target.getBoundingClientRect() })));
});
const frame = () => act(async () => {
  time += 16;
  const pending = [...frames.entries()];
  for (const [id, callback] of pending) if (frames.delete(id)) callback(time);
});
// Browser frames have a microtask checkpoint before the next frame starts.
const settle = async () => { for (let i = 0; i < 4; i++) await frame(); };

beforeEach(() => {
  hidden = false; rowHeight = 600; zeroRow = undefined; zeroPrefix = 0;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent,
    SVGElement: window.SVGElement, MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  window.matchMedia = query => ({ matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => true });
  window.getSelection = () => null;
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', LayoutObserver);
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '0', paddingTop: '0',
    paddingBottom: '0', direction: 'ltr', fontSize: '16px', lineHeight: '24px' }));
  window.getComputedStyle = globalThis.getComputedStyle;
  window.HTMLElement.prototype.scrollTo = function () {};
  frames = new Map(); nextFrame = 0; time = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  // linkedom has no layout engine. Inject the browser's measured condition: visible, then a
  // mounted display:none ancestor, then restored. This is not a reproduction of a user's route.
  vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const row = this.firstElementChild?.getAttribute('data-measurement-row');
    const width = hidden ? 0 : 800;
    const height = hidden ? 0 : row ? row === zeroRow || Number(row.slice(4)) < zeroPrefix ? 0 : rowHeight
      : this.hasAttribute('data-conversation-timeline-end-space') ? 300 : 600;
    return { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0,
      toJSON: () => ({ width, height }) };
  });
  useTimelineViewStore.setState({ views: {} });
  useUIStore.setState({ chatRenderMode: 'live', promptNavigatorEnabled: false, motionPreference: 'off' });
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const rows = (length: number, revision = 0) => Array.from({ length }, (_, i) => ({
  id: `row-${i}`, text: `Row ${i}, revision ${revision}`,
}));

describe.each([['ESM', LegendList], ['CJS', cjs.LegendList]] as const)('%s measurement', (_entry, List) => {
  it('renders after a long prefix of collapsed rows without recursive updates', async () => {
    zeroPrefix = 1800;
    const ref = React.createRef<LegendListRef>();
    const data = rows(2000);
    await act(async () => root.render(<List ref={ref} data={data} extraData={{ revision: 0 }}
      estimatedItemSize={60} style={{ height: 600 }} keyExtractor={item => item.id} recycleItems={false}
      renderItem={({ item }) => <div data-measurement-row={item.id}>{item.text}</div>} />));
    // The measurement settles at the commit's microtask checkpoint, without an extra frame.
    expect(ref.current!.getState().sizeAtIndex(1800)).toBe(600);
  });

  it('retains measured sizes through hidden updates and measures new sizes on restoration', async () => {
    const ref = React.createRef<LegendListRef>();
    const render = (revision: number, data = rows(3000, revision)) => <div
      data-legend-immediate-shrink style={{ display: hidden ? 'none' : 'block' }}>
      <List ref={ref} data={data} extraData={{ revision }} estimatedItemSize={60}
        style={{ height: 600 }} keyExtractor={item => item.id} recycleItems={false}
        renderItem={({ item }) => <div data-measurement-row={item.id}>{item.text}</div>} />
    </div>;
    await act(async () => root.render(render(0))); await settle();
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(600);
    const contentLength = ref.current!.getState().contentLength;
    const position = ref.current!.getState().positionAtIndex(1);
    hidden = true;
    for (let revision = 1; revision <= 3; revision++) {
      await act(async () => root.render(render(revision))); await frame();
      expect(ref.current!.getState().sizeAtIndex(0)).toBe(600);
      expect(ref.current!.getState().positionAtIndex(1)).toBe(position);
      expect(ref.current!.getState().contentLength).toBe(contentLength);
    }
    await act(async () => root.render(render(4, rows(3001, 4)))); await frame();
    expect(ref.current!.getState().data).toHaveLength(3001);
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(600);
    hidden = false; rowHeight = 72;
    await act(async () => root.render(render(5, rows(3001, 5)))); await settle();
    expect(mount.textContent).toContain('Row 0, revision 5');
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(72);
    expect(ref.current!.getState().positionAtIndex(1)).toBe(72);
    expect(ref.current!.getState().contentLength).toBeGreaterThan(0);
    // Measurements must keep working after restoration, not just preserve stale cached rows.
    rowHeight = 120;
    await act(async () => root.render(render(6))); await settle();
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(120);
    expect(ref.current!.getState().positionAtIndex(1)).toBe(120);
    // ResizeObserver must still deliver geometry changes even without another React render.
    rowHeight = 144; await notifyResize(); await settle();
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(144);
    expect(ref.current!.getState().positionAtIndex(1)).toBe(144);
  });

  it('accepts a real zero-height row with nonzero width and expands it again', async () => {
    const ref = React.createRef<LegendListRef>();
    const render = (revision: number) => <div data-legend-immediate-shrink>
      <List ref={ref} data={rows(8)} extraData={revision} estimatedItemSize={60}
        style={{ height: 600 }} keyExtractor={item => item.id}
        renderItem={({ item }) => <div data-measurement-row={item.id}>{item.text}</div>} />
    </div>;
    await act(async () => root.render(render(0))); await settle();
    zeroRow = 'row-0';
    await act(async () => root.render(render(1))); await settle();
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(0);
    expect(ref.current!.getState().positionAtIndex(1)).toBe(0);
    expect(ref.current!.getState().sizeAtIndex(1)).toBe(600);
    zeroRow = undefined;
    await act(async () => root.render(render(2))); await settle();
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(600);
    expect(ref.current!.getState().positionAtIndex(1)).toBe(600);
  });

  it('keeps an empty list usable through hidden mounting and later data', async () => {
    const ref = React.createRef<LegendListRef>();
    const render = (length: number) => <List ref={ref} data={rows(length)}
      estimatedItemSize={60} style={{ height: 600 }} keyExtractor={item => item.id}
      ListEmptyComponent={<div>No rows</div>}
      renderItem={({ item }) => <div data-measurement-row={item.id}>{item.text}</div>} />;
    hidden = true;
    await act(async () => root.render(render(0))); await settle();
    expect(mount.textContent).toContain('No rows');
    expect(ref.current!.getState().data).toHaveLength(0);
    await act(async () => root.render(render(3000))); await settle();
    hidden = false;
    await act(async () => root.render(render(3000))); await notifyResize(); await settle();
    expect(mount.textContent).toContain('Row 0, revision 0');
    expect(ref.current!.getState().sizeAtIndex(0)).toBe(600);
  });
});

it('keeps the real conversation timeline mounted through hidden streaming updates and restores rows', async () => {
  const identity = { runtime: 'agent' as const, threadId: 'measurement-fixture', branchId: 'main' };
  const history: ThreadHistoryItem[] = Array.from({ length: 1200 }, (_, i) => ({
    id: `h${i}`, parent: i ? `h${i - 1}` : null, thread_id: identity.threadId,
    run_id: `r${Math.floor(i / 2)}`, source: i % 2 ? 'assistant' : 'user', provider: null,
    content: i % 2 ? { content: { kind: 'text', text: `Synthetic answer ${i}` } } : `Prompt ${i}`,
  }));
  const render = (revision: number) => <div style={{ display: hidden ? 'none' : 'block' }}>
    <ConversationTimeline api={{} as ThreadsAPI} identity={identity} history={history} historyReady
      readOnly progress={revision ? [{ type: 'text', text: `Streaming revision ${revision}` }] : []}
      working={revision > 0} cwd="/synthetic" onQuote={() => {}} />
  </div>;
  await act(async () => root.render(render(0))); await settle();
  expect(mount.querySelector('[data-conversation-block]')).not.toBeNull();
  hidden = true;
  for (let revision = 1; revision <= 4; revision++) {
    await act(async () => root.render(render(revision))); await frame();
  }
  hidden = false;
  await act(async () => root.render(render(5))); await settle();
  expect(mount.querySelector('[data-conversation-block]')).not.toBeNull();
  expect(mount.textContent).toContain('Prompt');
  expect(mount.textContent).toContain('Streaming revision 5');
});
