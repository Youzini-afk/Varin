import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { useMainColumnGlide } from './railMotion';

it('keeps the combined final reading width until both independently interruptible sides settle', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('getComputedStyle', () => ({ marginLeft: '0', getPropertyValue: () => '0' }));
  let left = 250, right = 0;
  const widthOf = (el: HTMLElement): number => el.id === 'left' ? left : el.id === 'right' ? right : el.id === 'area' ? 1000 - left : 1000 - left - right;
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return widthOf(this); } });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = widthOf(this);
    return { top: 0, bottom: 600, left: 0, right: width, height: 600, width, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  window.HTMLElement.prototype.animate = () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  function Layout({ sidebar, panel }: { sidebar: boolean; panel: boolean }) {
    const side = React.useRef<HTMLElement>(null), aside = React.useRef<HTMLElement>(null);
    useMainColumnGlide(side, sidebar, true, 250, 'sidebar');
    useMainColumnGlide(aside, panel, true, 300);
    return <div><aside id="left" ref={side}/><div id="area"><main className="agent-conversation-canvas"><div className="absolute inset-0"><div className="chat-message-column"/></div></main><aside id="right" ref={aside}/></div></div>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const end = (id: string) => { const event = new window.Event('transitionend'); Object.assign(event, { propertyName: 'width' }); document.getElementById(id)!.dispatchEvent(event); };
  try {
    await act(async () => root.render(<Layout sidebar panel={false}/>));
    await act(async () => root.render(<Layout sidebar={false} panel/>));
    const main = host.querySelector('main')!;
    expect(main.style.getPropertyValue('--main-glide-width')).toBe('700px');
    left = 0; right = 100;
    await act(async () => end('left'));
    expect(main.style.getPropertyValue('--main-glide-width')).toBe('700px');
    // Reverse the panel before it reaches 300; the canvas targets its full width.
    await act(async () => root.render(<Layout sidebar={false} panel={false}/>));
    expect(main.style.getPropertyValue('--main-glide-width')).toBe('1000px');
    right = 0;
    await act(async () => end('right'));
    expect(main.hasAttribute('data-width-gliding')).toBe(false);
    expect(host.querySelector('#area')!.hasAttribute('data-layout-target-width')).toBe(false);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
