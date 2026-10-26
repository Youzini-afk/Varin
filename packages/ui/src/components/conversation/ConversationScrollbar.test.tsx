import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationScrollbar } from './ConversationScrollbar';
import { CHAT_TIMELINE_SCROLL_INTENT_EVENT } from './chatTimelineScrollState';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: () => 'Conversation scroll position' }) }));
let root: Root, viewport: HTMLElement, mount: HTMLElement;
let frames: Map<number, FrameRequestCallback>, frameId: number;
const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
const fire = (element: Element, type: string, values: Record<string, unknown> = {}) => act(() => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, values); element.dispatchEvent(event);
});
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
beforeEach(() => {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('CustomEvent', window.CustomEvent); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => true;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  const track = document.createElement('div'); viewport = document.createElement('div'); mount = document.createElement('div');
  document.body.append(track); track.append(viewport, mount);
  Object.defineProperties(track, { clientHeight: { value: 900 }, clientWidth: { value: 1000 } });
  Object.defineProperties(viewport, { clientHeight: { value: 500 }, scrollHeight: { value: 2000 },
    clientWidth: { value: 700 }, scrollWidth: { value: 700 }, scrollTop: { value: 0, writable: true }, scrollLeft: { value: 0, writable: true } });
  root = createRoot(mount);
  act(() => root.render(<ConversationScrollbar viewport={viewport} trackRef={{ current: track }} />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reveals on scrolling and edge hover, then fades after inactivity', () => {
  const overlay = mount.querySelector<HTMLElement>('.conversation-scrollbar')!;
  const rail = mount.querySelector<HTMLElement>('[role="scrollbar"]')!;
  expect(overlay.style.opacity).toBe('0');
  viewport.scrollTop = 400; fire(viewport, 'scroll'); flush();
  expect(overlay.style.opacity).toBe('1');
  tick(1000); expect(overlay.style.opacity).toBe('0');
  fire(rail, 'mouseover'); tick(2000); expect(overlay.style.opacity).toBe('1');
  fire(rail, 'mouseout', { relatedTarget: document.body }); tick(1000);
  expect(overlay.style.opacity).toBe('0');
  expect(rail.getAttribute('aria-controls')).toBe(viewport.id);
});

it('takes manual ownership and keeps a captured drag visible until release', () => {
  const intent = vi.fn(); viewport.addEventListener(CHAT_TIMELINE_SCROLL_INTENT_EVENT, intent);
  const overlay = mount.querySelector<HTMLElement>('.conversation-scrollbar')!;
  const thumb = mount.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]')!;
  fire(thumb, 'pointerdown', { button: 0, pointerId: 1, clientY: 100, clientX: 0 });
  expect(intent.mock.calls.map(([event]) => event.detail)).toEqual(['away-from-end', { dragging: true }]);
  fire(thumb, 'pointermove', { pointerId: 1, clientY: 250, clientX: 0 });
  expect(viewport.scrollTop).toBeGreaterThan(0);
  fire(viewport, 'scroll'); flush(); tick(3000); expect(overlay.style.opacity).toBe('1');
  fire(thumb, 'lostpointercapture', { pointerId: 1 }); tick(1000); expect(overlay.style.opacity).toBe('0');
  const rail = mount.querySelector<HTMLElement>('[role="scrollbar"]')!;
  fire(rail, 'keydown', { key: 'End' }); flush();
  expect(viewport.scrollTop).toBe(1500); expect(rail.getAttribute('aria-valuenow')).toBe('100');
  fire(rail, 'keydown', { key: 'Home' }); expect(viewport.scrollTop).toBe(0);
  expect(intent.mock.calls.map(([event]) => event.detail)).toEqual(['away-from-end', { dragging: true }, { dragging: false }, 'away-from-end', 'away-from-end']);
});
