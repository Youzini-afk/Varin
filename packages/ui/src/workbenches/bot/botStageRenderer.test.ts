import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAvatarId } from '@varin/protocol';

const frames = vi.hoisted(() => ({ queue: [] as ((time: number) => void)[], reads: [] as ((time: number) => void)[] }));
vi.mock('@/lib/motion/frame', () => ({
  requestFrame: (callback: (time: number) => void) => {
    frames.queue.push(callback);
    return { cancel: () => { const at = frames.queue.indexOf(callback); if (at >= 0) frames.queue.splice(at, 1); } };
  },
  requestAfterFrame: (callback: (time: number) => void) => {
    frames.reads.push(callback);
    return { cancel: () => { const at = frames.reads.indexOf(callback); if (at >= 0) frames.reads.splice(at, 1); } };
  },
}));

import type { BotMemberStatus, BotStageEvent, BotStageLead } from './botStageDirector';
import { BotStageRenderer, type BotStageFeed } from './botStageRenderer';
import { VarinFigureRig } from './varinFigureRig';

const AVATARS: AgentAvatarId[] = ['slope-lilac', 'dome-ivory', 'taper-sage', 'pebble-blue', 'overlap-coral', 'notch-ochre'];
const lead = (n: number, status: BotMemberStatus = 'thinking', subs = 0): BotStageLead => ({
  key: `lead-${n}`, threadId: `lead-${n}`, branchId: 'main', title: `Lead ${n}`, avatar: AVATARS[n % AVATARS.length]!, status, sessionThreadId: 'chat',
  subs: Array.from({ length: subs }, (_, i) => ({ key: `sub-${n}-${i}`, threadId: `sub-${n}-${i}`, branchId: 'main', title: 'Helper', avatar: AVATARS[(n + i + 1) % AVATARS.length]!, status: 'thinking' as const })),
});

describe('Bot stage', () => {
  let host: HTMLElement;
  let time = 0;
  beforeEach(() => {
    const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    frames.queue.length = 0;
    frames.reads.length = 0;
    time = 0;
    host = document.createElement('span');
    document.body.append(host);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const run = (seconds: number): void => {
    for (let n = 0; n < seconds * 60; n++) {
      time += 1000 / 60;
      for (const callback of frames.queue.splice(0)) callback(time);
      for (const callback of frames.reads.splice(0)) callback(time);
    }
  };
  const stage = () => {
    const rig = new VarinFigureRig(host, { state: 'supervising', compact: false, still: false, wide: true });
    const renderer = new BotStageRenderer(rig);
    let id = 0;
    const events: { id: number; event: BotStageEvent }[] = [];
    const feed = (leads: BotStageLead[], moments: BotStageEvent[] = [], typing = false): BotStageFeed => {
      for (const event of moments) events.push({ id: ++id, event });
      return { leads, events: [...events], typing };
    };
    return { rig, renderer, feed };
  };
  // The wide figure's stage layers: beside her, on the ledge, in front, and flights.
  const layer = (index: number) => host.querySelectorAll('svg > g.bot-figure-team')[index]!;
  const seated = () => layer(0).firstElementChild?.children.length ?? 0;
  const flying = () => layer(3).firstElementChild?.children.length ?? 0;
  const chips = () => [...host.querySelectorAll('text')].map(node => node.textContent).filter(text => text?.startsWith('+'));

  it('seats who fits beside her and piles the rest, keeping whoever needs you out of the pile', () => {
    const { rig, renderer, feed } = stage();
    // Without a measured width the scene is her own width: one seat a side next to her hair.
    renderer.update(feed([lead(1), lead(2), lead(3), lead(4), lead(5), lead(6, 'needs')]));
    run(.5);
    expect(seated()).toBe(6);
    // Three a side: one seat each, the other two in a pile.
    expect(chips()).toEqual(['+2', '+2']);
    // The member that needs you keeps the seat on its side (lead 6, left); the earlier ones pile up small.
    const size = (index: number) => layer(0).firstElementChild!.children[index]!.firstElementChild!.getAttribute('transform')!.match(/scale\(([\d.]+)\)/)![1];
    expect(size(5)).toBe((140 / 64).toFixed(4));
    expect(size(1)).toBe((96 / 64).toFixed(4));
    expect(size(0)).toBe((140 / 64).toFixed(4));
    renderer.dispose();
    rig.dispose();
  });

  it('hands a card to a new lead and seats it only when the card arrives', () => {
    const { rig, renderer, feed } = stage();
    renderer.update(feed([]));
    run(.1);
    renderer.update(feed([lead(1)], [{ kind: 'dispatch', lead: 'lead-1' }]));
    expect(rig.move?.name).toMatch(/^throw[LR]$/);
    expect(flying()).toBe(0);
    run(.6);
    expect(flying()).toBe(1);
    run(1.5);
    expect(flying()).toBe(0);
    expect(rig.move).toBeNull();
    // Seated now: she watches it.
    expect(rig.focus).not.toBeNull();
    renderer.dispose();
    rig.dispose();
  });

  it('grades results: a large finished request cheers, a reply while you type only glances', () => {
    const { rig, renderer, feed } = stage();
    renderer.update(feed([]));
    run(.1);
    renderer.update(feed([], [{ kind: 'complete', weight: 'large', outcome: 'ok' }]));
    expect(rig.move?.name).toBe('cheerLite');
    run(2);
    renderer.update(feed([], [{ kind: 'reply', outcome: 'ok' }], true));
    expect(rig.move).toBeNull();
    renderer.dispose();
    rig.dispose();
  });

  it('places the roster without playing anything a late figure missed', () => {
    const { rig, renderer, feed } = stage();
    renderer.update(feed([lead(1, 'thinking', 2)], [{ kind: 'dispatch', lead: 'lead-1' }, { kind: 'complete', weight: 'large', outcome: 'ok' }]));
    expect(rig.move).toBeNull();
    run(.2);
    expect(seated()).toBe(1);
    expect(flying()).toBe(0);
    renderer.dispose();
    expect(layer(0).children).toHaveLength(0);
    rig.dispose();
  });
});
