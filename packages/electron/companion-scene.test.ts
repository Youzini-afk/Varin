import { expect, it, vi } from 'vitest';
import { CompanionSceneWindows, companionSceneLayout, type CompanionSceneDescriptor, type CompanionScenePayload } from './companion-scene';

const descriptor = (revision: number, extra: Partial<CompanionSceneDescriptor> = {}): CompanionSceneDescriptor => ({ revision, scope: 'host/thread/branch', kind: 'reading', phase: 'active', outcome: null, count: null, suppressed: false, reducedMotion: false, menuOpen: false, cue: 'engaged', ...extra });
const viewport = { x: 0, y: 0, width: 360, height: 360, viewportWidth: 360, viewportHeight: 480 };
const area = { x: 0, y: 0, width: 1280, height: 800 };
function fixture() {
  const owner = { id: 7, closed: false, visible: true, minimized: false, pinned: false, bounds: { x: 100, y: 80, width: 360, height: 480 },
    isDestroyed() { return this.closed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    isAlwaysOnTop() { return this.pinned; }, getContentBounds() { return this.bounds; } };
  const windows: { closed: boolean; visible: boolean; pinned: boolean; bounds: typeof area; ready?: () => void; payloads: CompanionScenePayload[] }[] = [];
  let release: (() => void) | undefined;
  const manager = new CompanionSceneWindows(bounds => {
    const win = { closed: false, visible: false, pinned: false, bounds, payloads: [] as CompanionScenePayload[] }; windows.push(win);
    return { isDestroyed: () => win.closed, close: () => { win.closed = true; win.visible = false; }, hide: () => { win.visible = false; },
      showInactive: () => { win.visible = true; }, setBounds: value => { win.bounds = value; }, setAlwaysOnTop: value => { win.pinned = value; },
      onReady: cb => { (win as typeof windows[number]).ready = cb; },
      publish: async payload => { win.payloads.push(payload); if (release === undefined) return; await new Promise<void>(resolve => { release = resolve; }); },
    };
  }, () => area);
  return { owner, windows, manager, stall: () => { release = () => {}; }, release: () => { release?.(); release = undefined; } };
}
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };

it('uses one inert scene, preserves character DIP anchor and follows visibility and pin state', async () => {
  const f = fixture(); f.manager.update(f.owner, descriptor(1), viewport);
  expect(f.windows[0]?.visible).toBe(false);
  f.windows[0]?.ready?.(); await flush(); expect(f.windows[0]?.visible).toBe(true);
  const geometry = companionSceneLayout(f.owner.bounds, viewport, area);
  expect(geometry.bounds.width).toBe(522); expect(geometry.bounds.y + geometry.bounds.height).toBe(440);
  expect(geometry.bounds.x + geometry.layout.character.x * geometry.bounds.width).toBe(100);
  f.owner.bounds.x = 220; f.owner.pinned = true; f.manager.refresh(f.owner.id); await flush();
  expect(f.windows).toHaveLength(1); expect(f.windows[0]?.bounds.x).toBe(139); expect(f.windows[0]?.pinned).toBe(true);
  f.owner.visible = false; f.manager.refresh(f.owner.id); expect(f.windows[0]?.visible).toBe(false);
  await flush(); expect(f.windows[0]?.visible).toBe(false);
  f.owner.visible = true; f.manager.refresh(f.owner.id); await flush(); expect(f.windows[0]?.visible).toBe(true);
  f.manager.clearAll(); expect(f.windows[0]?.closed).toBe(true);
});

it('ignores stale data, suppresses immediately during drag and cannot resurrect after late render or close', async () => {
  const f = fixture(); f.manager.update(f.owner, descriptor(10), viewport); f.windows[0]?.ready?.(); await flush();
  f.manager.update(f.owner, descriptor(9, { kind: 'permission' }), viewport); await flush();
  expect(f.windows[0]?.payloads.at(-1)?.descriptor.kind).toBe('reading');
  f.stall(); f.manager.update(f.owner, descriptor(11, { kind: 'editing' }), viewport); await flush();
  f.manager.block(f.owner.id, true); expect(f.windows[0]?.visible).toBe(false);
  f.release(); await flush(); expect(f.windows[0]?.visible).toBe(false);
  f.manager.update(f.owner, descriptor(12, { suppressed: true }), viewport); f.manager.block(f.owner.id, false); await flush();
  expect(f.windows[0]?.visible).toBe(false);
  f.manager.update(f.owner, descriptor(13), viewport); await flush(); expect(f.windows[0]?.visible).toBe(true);
  f.manager.clear(f.owner.id); f.windows[0]?.ready?.(); await flush(); expect(f.windows[0]?.closed).toBe(true);
  expect(() => f.manager.update(f.owner, descriptor(14, { outcome: 'allowed' }), viewport)).toThrow('outcome');
  expect(() => f.manager.update(f.owner, descriptor(14), { ...viewport, width: 999 })).toThrow('viewport');
});

it('does not replay an expired short-event tail when the decorative window loads late', async () => {
  let now = 1_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const f = fixture();
    f.manager.update(f.owner, descriptor(1), viewport);
    f.manager.update(f.owner, descriptor(2, { phase: 'withdraw' }), viewport);
    now += 700;
    f.windows[0]?.ready?.(); await flush();
    expect(f.windows[0]?.visible).toBe(false);
    f.manager.update(f.owner, descriptor(3, { phase: 'withdraw', menuOpen: true }), viewport); await flush();
    expect(f.windows[0]?.visible).toBe(false);
    f.manager.update(f.owner, descriptor(4, { kind: 'permission' }), viewport); await flush();
    expect(f.windows[0]?.visible).toBe(true);
  } finally { clock.mockRestore(); }
});
