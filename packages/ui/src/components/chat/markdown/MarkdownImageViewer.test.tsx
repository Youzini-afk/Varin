import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, test, vi } from 'vitest';
import { MarkdownImageViewer } from './MarkdownImageViewer';

const dialog = vi.hoisted(() => ({ finish: (_open: boolean) => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/dialog', async () => {
  const React = await import('react');
  return {
    Dialog: ({ children, onOpenChange, onOpenChangeComplete }: React.PropsWithChildren<{ onOpenChange(open: boolean): void; onOpenChangeComplete(open: boolean): void }>) => {
      dialog.finish = onOpenChangeComplete;
      return <div><button data-close onClick={() => onOpenChange(false)}>Close</button>{children}</div>;
    },
    DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
      // Portal descendants may mount after the viewer's first layout effect.
      const [mounted, setMounted] = React.useState(false);
      React.useEffect(() => { setMounted(true); }, []);
      return mounted ? <div {...props}>{children}</div> : null;
    },
    DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  };
});
afterEach(() => vi.unstubAllGlobals());

test('measures a deferred portal, fits/zooms originals, reuses group reads and retains media until exit completes', async () => {
  const { window, document } = parseHTML('<html><body><main></main></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, Element: window.Element, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 800 }, clientHeight: { configurable: true, get: () => 600 },
  });
  const container = document.querySelector('main')!, root = createRoot(container), closed = vi.fn(), release = vi.fn();
  const load = vi.fn(async (source: string) => ({ src: source, release }));
  const click = (selector: string) => act(async () => container.querySelector<HTMLElement>(selector)!.click());
  const decoded = async () => {
    const image = container.querySelector('img')!;
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 1600 }, naturalHeight: { configurable: true, value: 1200 } });
    await act(async () => image.dispatchEvent(new window.Event('load')));
    return image;
  };
  try {
    await act(async () => root.render(<MarkdownImageViewer items={[{ source: 'one', label: 'One' }, { source: 'two', label: 'Two' }]} initialIndex={0} load={load} onClose={closed} />));
    const image = await decoded();
    expect(image.style.width).toBe('800px'); expect(image.style.height).toBe('600px');
    await click('[aria-label="markdownRenderer.mermaid.actions.zoomInTitle"]');
    expect(image.style.width).toBe('1000px');
    await click('[aria-label="chat.toolOutputDialog.image.nextAria"]'); await decoded();
    await click('[aria-label="chat.toolOutputDialog.image.previousAria"]'); await decoded();
    expect(load.mock.calls.map(call => call[0])).toEqual(['one', 'two']);
    await click('[data-close]'); expect(closed).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    await act(async () => dialog.finish(false)); expect(closed).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
  expect(release).toHaveBeenCalledTimes(2);
});
