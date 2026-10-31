import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { VARIN_FIGURE_LAYERS } from './varinFigureArt';
import { VarinFigureRig } from './varinFigureRig';

describe('Bot figure', () => {
  let host: HTMLElement;
  let visibility: DocumentVisibilityState;
  let notify: () => void;

  beforeEach(() => {
    const { window, document, Event } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
    notify = () => { document.dispatchEvent(new Event('visibilitychange')); };
    frames.queue.length = 0;
    frames.reads.length = 0;
    host = document.createElement('span');
    document.body.append(host);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const flush = (time: number): void => {
    for (const callback of frames.queue.splice(0)) callback(time);
    for (const callback of frames.reads.splice(0)) callback(time);
  };

  it('keeps terminal output scrolling after the authored row pool has been reused', () => {
    const figure = new VarinFigureRig(host, { state: 'tool-shell', compact: false, still: false });
    for (let n = 0; n < 24 * 60; n++) flush(n * 1000 / 60);
    const rows = [...host.querySelectorAll('g[clip-path*="term"] > g > g')];
    expect(rows.filter(row => row.getAttribute('opacity') === '1')).toHaveLength(7);
    figure.dispose();
  });

  it('holds a still pose without running frames', () => {
    const figure = new VarinFigureRig(host, { state: 'sleeping', compact: true, still: true });
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.dataset.state).toBe('sleeping');
    figure.setState('waiting');
    expect(host.dataset.state).toBe('waiting');
    expect(frames.queue).toHaveLength(0);
    figure.dispose();
    expect(host.querySelector('svg')).toBeNull();
  });

  it('recolours the accent parts for the theme and leaves the eyes alone', () => {
    const figure = new VarinFigureRig(host, { state: 'listening', compact: false, still: true });
    const fills = (): string[] => [...host.querySelectorAll('[fill]')].map(node => node.getAttribute('fill') ?? '');
    const before = fills();
    expect(before).toContain('#82a3e6');
    figure.setAccent({ key: 'test', tint: () => '#123456' });
    const after = fills();
    const count = (list: string[], fill: string): number => list.filter(value => value === fill).length;
    expect(after).toContain('#123456');
    // The traced brows share the knit's mist blue but stay, as do the eyes.
    const brows = [...VARIN_FIGURE_LAYERS.browL, ...VARIN_FIGURE_LAYERS.browR].filter(([fill]) => fill === '#82a3e6').length;
    expect(count(after, '#82a3e6')).toBe(brows);
    expect(count(after, '#576487')).toBe(count(before, '#576487'));
    expect(host.querySelector('radialGradient stop')?.getAttribute('stop-color')).toBe('rgb(18,52,86)');
    figure.dispose();
  });

  it('animates only while the page is visible', () => {
    const figure = new VarinFigureRig(host, { state: 'idle', compact: false, still: false });
    expect(frames.queue).toHaveLength(1);
    flush(16);
    figure.setState('thinking');
    flush(32);
    expect(frames.queue).toHaveLength(1);

    visibility = 'hidden';
    notify();
    expect(frames.queue).toHaveLength(0);
    flush(48);
    expect(frames.queue).toHaveLength(0);

    visibility = 'visible';
    notify();
    expect(frames.queue).toHaveLength(1);
    figure.dispose();
    expect(frames.queue).toHaveLength(0);
  });

  it('cancels a pending gesture when she goes offline and stops only after her pose has settled', () => {
    const figure = new VarinFigureRig(host, { state: 'idle', compact: false, still: false });
    const burst = vi.spyOn(figure, 'burst');
    figure.play('cheerLite');
    flush(0);
    figure.setState('offline');
    expect(figure.move).toBeNull();
    expect(frames.queue).toHaveLength(1);
    for (let n = 1; n <= 600 && frames.queue.length; n++) flush(n * 1000 / 60);
    expect(burst).not.toHaveBeenCalled();
    expect(frames.queue).toHaveLength(0);
    expect(host.querySelector('g[filter]')).not.toBeNull();
    figure.setState('working');
    expect(frames.queue).toHaveLength(1);
    figure.dispose();
  });

  it('keeps a reaction playing through a change of her round, but not into rest', () => {
    const figure = new VarinFigureRig(host, { state: 'thinking', compact: false, still: false });
    figure.play('ack');
    flush(16);
    figure.setState('tool-read');
    expect(figure.move?.name).toBe('ack');
    figure.play('nod');
    figure.setState('replying');
    expect(figure.move).toBeNull();
    figure.play('present');
    figure.setState('sleeping');
    expect(figure.move).toBeNull();
    figure.dispose();
  });

  it('holds the prop of the tool her round is running and nothing for other states', () => {
    const figure = new VarinFigureRig(host, { state: 'tool-read', compact: false, still: true });
    const sheet = host.querySelector('rect[width="300"]')!.parentElement!.parentElement as unknown as SVGGElement;
    const pen = host.querySelector('line[stroke-width="15"]')!.parentElement as unknown as SVGGElement;
    expect(sheet.style.display).toBe('');
    expect(pen.style.display).toBe('none');
    figure.setState('tool-edit');
    expect(sheet.style.display).toBe('none');
    expect(pen.style.display).toBe('');
    figure.setState('idle');
    expect(pen.style.display).toBe('none');
    figure.dispose();
  });

  it('keeps compact thinking and sleeping marks inside the head crop', () => {
    const figure = new VarinFigureRig(host, { state: 'thinking', compact: true, still: true });
    const [left, top, width, height] = host.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);
    const marks = host.querySelector('svg > g:last-child')!;
    const dots = [...marks.children].filter(node => node.localName === 'circle');
    expect(dots).toHaveLength(3);
    for (const node of dots) {
      const x = Number(node.getAttribute('cx')), y = Number(node.getAttribute('cy'));
      const radius = Number(node.getAttribute('r')) * 1.4 * 1.08;
      expect(x - radius).toBeGreaterThan(left); expect(x + radius).toBeLessThan(left + width);
      expect(y - radius).toBeGreaterThan(top); expect(y + radius).toBeLessThan(top + height);
    }
    figure.setState('sleeping');
    const zs = [...marks.children].filter(node => node.localName === 'path');
    expect(zs).toHaveLength(3);
    for (const node of zs) {
      const [, x, y, scale] = node.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!;
      expect(Number(x) - 21 * Number(scale)).toBeGreaterThan(left);
      expect(Number(x) + 21 * Number(scale)).toBeLessThan(left + width);
      expect(Number(y) - 19 * Number(scale)).toBeGreaterThan(top);
      expect(Number(y) + 19 * Number(scale)).toBeLessThan(top + height);
    }
    figure.dispose();
  });

  it('measures pointer geometry on input and layout changes, not on every animation frame', () => {
    const figure = new VarinFigureRig(host, { state: 'idle', compact: false, still: false });
    const measure = vi.spyOn(host, 'getBoundingClientRect');
    const move = new window.Event('pointermove');
    Object.assign(move, { clientX: 50, clientY: 50 });
    window.dispatchEvent(move);
    for (let n = 0; n < 15; n++) flush(n * 1000 / 60);
    expect(measure).toHaveBeenCalledOnce();
    window.dispatchEvent(new window.Event('scroll'));
    flush(300);
    expect(measure).toHaveBeenCalledTimes(2);
    figure.dispose();
    window.dispatchEvent(move);
    expect(frames.reads).toHaveLength(0);
  });
});
