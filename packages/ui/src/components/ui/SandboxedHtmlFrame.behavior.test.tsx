import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

afterEach(() => vi.unstubAllGlobals());

it('keeps ordinary browsers on srcdoc with an opaque sandbox', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body);
  await act(async () => root.render(<SandboxedHtmlFrame title="Work" policy="interactive" html="<h1>Work</h1>" />));
  const frame = document.querySelector('iframe')!;
  expect(frame.getAttribute('srcDoc') ?? frame.getAttribute('srcdoc')).toBe('<h1>Work</h1>');
  expect(frame.hasAttribute('src')).toBe(false);
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('referrerPolicy') ?? frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  await act(async () => root.unmount());
});

it('installs native HTML only once in the matching live frame and suppresses the bootstrap load', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  Object.assign(window, { __VARIN_DESKTOP_RUNTIME__: { runtime: 'tauri' } });
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body), ref = React.createRef<HTMLIFrameElement>(), onLoad = vi.fn();
  const render = (html: string) => root.render(<SandboxedHtmlFrame ref={ref} title="Work" policy="interactive" html={html} onLoad={onLoad} />);
  await act(async () => render('<h1>First</h1>'));
  const frame = document.querySelector('iframe')!, target = { postMessage: vi.fn() };
  Object.defineProperty(frame, 'contentWindow', { value: target });
  const id = new URL(frame.getAttribute('src')!).hash.slice(1);
  expect(frame.hasAttribute('srcdoc') || frame.hasAttribute('srcDoc')).toBe(false);
  expect(new URL(frame.getAttribute('src')!).pathname).toBe('/interactive');
  expect(ref.current).toBe(frame);
  const ready = (source = target, generation = id) => {
    const event = new window.Event('message'); Object.assign(event, { source, data: { type: 'varin-preview:ready', id: generation } });
    window.dispatchEvent(event);
  };
  await act(async () => frame.dispatchEvent(new window.Event('load')));
  expect(onLoad).not.toHaveBeenCalled();
  ready({ postMessage: vi.fn() }); ready(target, 'stale-generation');
  expect(target.postMessage).not.toHaveBeenCalled();
  ready(); ready();
  expect(target.postMessage).toHaveBeenCalledTimes(1);
  expect(target.postMessage).toHaveBeenCalledWith({ type: 'varin-preview:install', id, html: '<h1>First</h1>' }, '*');
  await act(async () => frame.dispatchEvent(new window.Event('load')));
  expect(onLoad).toHaveBeenCalledTimes(1);
  await act(async () => render('<h1>Second</h1>'));
  const second = document.querySelector('iframe')!;
  expect(second).not.toBe(frame); expect(ref.current).toBe(second);
  ready();
  expect(target.postMessage).toHaveBeenCalledTimes(1);
  const next = { postMessage: vi.fn() }; Object.defineProperty(second, 'contentWindow', { value: next });
  ready(next, new URL(second.getAttribute('src')!).hash.slice(1));
  expect(next.postMessage).toHaveBeenCalledWith(expect.objectContaining({ html: '<h1>Second</h1>' }), '*');
  await act(async () => root.unmount());
  expect(ref.current).toBeNull();
  ready(next, new URL(second.getAttribute('src')!).hash.slice(1));
  expect(next.postMessage).toHaveBeenCalledTimes(1);
});
