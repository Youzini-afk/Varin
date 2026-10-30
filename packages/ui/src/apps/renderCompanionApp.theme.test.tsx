import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeAPIs } from '@varin/application-client';
import { CompanionPlayback } from '@/components/companion/playback.mjs';
import { CompanionAccentMaterial } from '@/components/companion/companionAccentMaterial';
import { renderCompanionApp } from './renderCompanionApp';

// Keep real root composition, theme owner, asset admission, player, painting and
// material. Only Host/native observation, bitmap decoding and canvas IO are fixtures.
const boundary = vi.hoisted(() => ({ scene: vi.fn(), native: vi.fn(), persist: vi.fn(), refresh: vi.fn(), root: undefined as Root | undefined, grab: undefined as undefined | (() => void), release: undefined as undefined | (() => void), phase: 'rest', working: true, stopKey: undefined as string | undefined, update: undefined as (() => void) | undefined, consumed: vi.fn(), blockPaint: false, noop: () => {} }));
vi.mock('react-dom/client', async original => {
  const actual = await original<typeof import('react-dom/client')>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => (boundary.root = actual.createRoot(...args)) };
});
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => 1, getRuntimeKey: () => 'test-host', subscribeRuntimeEndpointChanged: () => boundary.noop, runtimeFetch: async () => ({ ok: true, json: async () => ({ themes: [] }) }) }));
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => false, isDesktopShell: () => true, isDesktopLocalOriginActive: () => true, invokeDesktop: boundary.native }));
vi.mock('@/lib/desktopNative', () => ({ setDesktopWindowTheme: boundary.native }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: boundary.persist }));
vi.mock('@/lib/i18n', () => ({ initializeLocale: boundary.noop, I18nProvider: ({ children }: { children: React.ReactNode }) => children, useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/companion/useCompanionAssociation', () => ({ useCompanionAssociation: () => ({ association: { route: 'agent-companion', botId: null }, bots: [], choice: { botId: null }, choose: boundary.noop }) }));
vi.mock('@/components/companion/useCompanionAttention', () => ({ useCompanionAttention: () => ({ snapshot: null, health: 'current', observationRevision: 1, refresh: boundary.refresh, projectionAPI: null }) }));
vi.mock('@/components/companion/useCompanionDirector', async () => {
  const React = await import('react');
  return { useCompanionDirector: () => {
    const [, update] = React.useReducer(value => value + 1, 0); boundary.update = update;
    return { health: 'current', interactionRoute: 'agent-companion', inspectionRoute: null,
      body: { verb: boundary.stopKey ? 'executor-stopped' : 'review-portfolio', workActive: boundary.working,
        subjectRoute: 'agent-companion', edge: boundary.stopKey ? {key:boundary.stopKey,kind:'executor-stopped'} : null, attentionItem:null,subject:null },
      discardTransient: boundary.noop, consumeEdge: (key:string) => { boundary.consumed(key); boundary.stopKey=undefined; update(); } };
  } };
});
vi.mock('@/components/companion/useDirectorPortfolio', () => ({ useDirectorPortfolio: () => ({ portfolio: { subjectKey: 'existing-task' }, legend: [] }) }));
vi.mock('@/components/companion/useCompanionScene', () => ({ useCompanionScene: boundary.scene }));
vi.mock('@/components/companion/useCompanionWindow', async () => {
  const React = await import('react');
  return { useCompanionWindow: (_canvas: unknown, _review: boolean, beforeLift: () => void) => {
    const [phase, setPhase] = React.useState('rest'); boundary.phase = phase;
    boundary.grab = () => { beforeLift(); setPhase('lifting'); };
    boundary.release = () => setPhase('landing');
    return { phase, handlers: {}, refreshHitMask: boundary.noop, worldStool: boundary.noop, settle: boundary.noop, resetLocalInteraction: boundary.noop, tapRevision: 0, hoverRevision: 0, activityRevision: 0, hovered: false };
  } };
});
let cleanup: (() => void) | undefined;
afterEach(async () => { await act(async () => boundary.root?.unmount()); cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountHarness() {
  vi.clearAllMocks(); boundary.working=true; boundary.stopKey=undefined; boundary.blockPaint=false;
  const { window, document } = parseHTML('<html><head></head><body style="background-color:transparent"><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto);
  const write = vi.fn();
  Object.defineProperties(window, { location: { configurable: true, value: { search: '?review=1', origin: 'http://localhost', href: 'http://localhost/companion.html?review=1' } }, localStorage: { configurable: true, value: { getItem: () => JSON.stringify({ mode: 'light', lightThemeId: 'varin-light', darkThemeId: 'varin-dark', splash: { light: { background: '#fff', foreground: '#000' }, dark: { background: '#000', foreground: '#fff' } } }), setItem: write } } });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  const media = () => ({ matches: false, addEventListener: boundary.noop, removeEventListener: boundary.noop });
  vi.stubGlobal('matchMedia', media);
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const raw = readFileSync(new URL('../../../web/public/companion-assets/bundle.json', import.meta.url), 'utf8');
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => String(url).includes('bundle.json') ? { ok: true, text: async () => raw } : { ok: true, blob: async () => new Blob() }));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4096, height: 4096, close: boundary.noop })));
  // Registered real masks process deterministic blue canvas samples. Raster decode
  // fidelity belongs to artwork tests; this checks the real render/material path.
  const contexts = new WeakMap<object, CanvasRenderingContext2D>();
  const paintedPixels = vi.fn();
  const originalCreate = document.createElement.bind(document);
  document.createElement = ((name: string, options?: ElementCreationOptions) => {
    const node = originalCreate(name, options);
    if (name === 'canvas') Object.assign(node, { getContext: () => {
      if (!contexts.has(node)) contexts.set(node, { clearRect() {}, drawImage() {}, save() {}, restore() {}, getImageData: () => {
        const data = new Uint8ClampedArray(512 * 512 * 4);
        for (let i = 0; i < data.length; i += 4) data.set([63, 142, 243, 255], i);
        return { width: 512, height: 512, data };
      }, putImageData(image: ImageData) {
        if (boundary.blockPaint) throw new Error('fixture canvas paint unavailable');
        const totals = [0, 0, 0, 0];
        for (let i = 0; i < image.data.length; i++) totals[i % 4]! += image.data[i]!;
        paintedPixels(totals.join(':'));
      } } as unknown as CanvasRenderingContext2D);
      return contexts.get(node);
    } });
    return node;
  }) as typeof document.createElement;
  cleanup = () => { document.createElement = originalCreate; };
  const request = vi.spyOn(CompanionPlayback.prototype, 'request');
  const grab = vi.spyOn(CompanionPlayback.prototype, 'grab');
  const release = vi.spyOn(CompanionPlayback.prototype, 'release');
  const material = vi.spyOn(CompanionAccentMaterial.prototype, 'apply');
  const listThreads = vi.fn(async () => []);
  const apis = { threads: { list: listThreads }, extensions: {} } as unknown as RuntimeAPIs;
  await act(async () => renderCompanionApp(apis));
  // Exercise the real selected-assets review control, not a mocked mode predicate.
  const selectedReview = document.querySelector<HTMLInputElement>('[aria-label="Review selected director assets"]')!;
  expect(selectedReview).toBeDefined();
  await act(async () => { selectedReview.checked = true; selectedReview.dispatchEvent(new window.Event('click', { bubbles: true })); });
  const tick = async (now: number) => { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); }); };
  // Bundle digest/decode are async; wait on their actual completion, not wall time.
  for (let step = 0; step < 30 && !material.mock.calls.length; step++) {
    await act(async () => new Promise<void>(resolve => setImmediate(resolve)));
    await tick(step * 16);
  }
  expect(material.mock.calls.length).toBeGreaterThan(0);
  await tick(1000); await tick(1200);
  expect(material.mock.lastCall?.[1].action).toBe('work-active');
  return {window,document,write,paintedPixels,request,grab,release,material,listThreads,tick};
}

it('repaints actual work, paused and grabbed exposures without restarting player, cue or scene identity', async () => {
  const {window,document,write,paintedPixels,request,grab,release,material,listThreads,tick}=await mountHarness();
  const switchTheme = async (id: string) => {
    const last = material.mock.lastCall!;
    const scene = boundary.scene.mock.lastCall!;
    expect(scene[5]).toBeDefined();
    expect(material.mock.results.at(-1)?.value).toBe(true);
    const controller = request.mock.contexts.at(-1) as CompanionPlayback;
    const time = controller.timeMs, gesture = controller.gesture;
    const pixels = paintedPixels.mock.lastCall![0];
    const previous = { package: last[1], bitmap: last[2], exposure: last[3], epoch: last[4], signature: last[5]!.signature, session: scene[2], cue: scene[5], requests: request.mock.calls.length, grabs: grab.mock.calls.length, releases: release.mock.calls.length, lists: listThreads.mock.calls.length };
    await act(async () => window.dispatchEvent(new window.CustomEvent('varin:settings-synced', { detail: { useSystemTheme: false, themeVariant: 'light', lightThemeId: id } })));
    const next = material.mock.lastCall!;
    expect(paintedPixels.mock.lastCall![0]).not.toBe(pixels);
    expect(controller.timeMs).toBe(time); expect(controller.gesture).toBe(gesture);
    expect(material.mock.results.at(-1)?.value).toBe(true);
    expect(next[1]).toBe(previous.package); expect(next[2]).toBe(previous.bitmap); expect(next[3]).toBe(previous.exposure); expect(next[4]).toBe(previous.epoch); expect(next[5]!.signature).not.toBe(previous.signature);
    expect(boundary.scene.mock.lastCall![2]).toBe(previous.session); expect(boundary.scene.mock.lastCall![5]).toBe(previous.cue);
    expect(request).toHaveBeenCalledTimes(previous.requests); expect(grab).toHaveBeenCalledTimes(previous.grabs); expect(release).toHaveBeenCalledTimes(previous.releases); expect(listThreads).toHaveBeenCalledTimes(previous.lists);
    expect(document.body.style.backgroundColor).toBe('transparent'); expect(write).not.toHaveBeenCalled(); expect(boundary.native).not.toHaveBeenCalled(); expect(boundary.persist).not.toHaveBeenCalled();
  };
  await switchTheme('aura-light');
  const nextButton = [...document.querySelectorAll('button')].find(button => button.textContent === 'Next exposure')!;
  expect(nextButton).toBeDefined();
  await act(async () => nextButton.dispatchEvent(new window.Event('click', { bubbles: true })));
  const pausedExposure = material.mock.lastCall![3];
  await tick(1400); await tick(1600);
  expect(material.mock.lastCall![3]).toBe(pausedExposure);
  await switchTheme('vesper-light');
  await act(async () => boundary.grab!());
  expect(boundary.phase).toBe('lifting'); expect(grab.mock.results.at(-1)?.value).toBe(true);
  expect(material.mock.lastCall![1].gesture).toBeDefined();
  await switchTheme('nord-light');
  expect(boundary.phase).toBe('lifting');
});


it('consumes an executor-stop edge once only after real recovery has painted its matching safe observation', async () => {
 const {tick,material}=await mountHarness();
 boundary.blockPaint=true;boundary.working=false;boundary.stopKey='exact-stop';
 await act(async()=>boundary.update!());
 expect(boundary.consumed).not.toHaveBeenCalled();
 // Let the real player select/route to supervision while actual paint is unavailable.
 for(let n=0;n<100;n++) await tick(1300+n*50);
 expect(material.mock.lastCall?.[1].action).toBe('director-supervise');
 expect(boundary.consumed).not.toHaveBeenCalled();
 boundary.blockPaint=false;
 for(let n=0;n<160 && !boundary.consumed.mock.calls.length;n++) await tick(6400+n*50);
 expect(boundary.consumed).toHaveBeenCalledExactlyOnceWith('exact-stop');
 for(let n=0;n<20;n++) await tick(15000+n*50);
 expect(boundary.consumed).toHaveBeenCalledTimes(1);
});
