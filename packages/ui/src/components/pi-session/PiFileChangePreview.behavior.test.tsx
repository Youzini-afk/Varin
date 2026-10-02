import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, test, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { projectFileChanges, type FileChangePhase } from './fileChangePreview';

afterEach(() => vi.unstubAllGlobals());

test('follows real changes, pauses for reading, resumes and keeps navigation through the saved-message handoff', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '13px' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  // Linkedom has no layout. Supply the viewport geometry, retaining the real
  // virtualizer and React event handlers.
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return 176; } },
    offsetWidth: { configurable: true, get() { return 640; } },
    clientHeight: { configurable: true, get() { return 176; } },
    scrollHeight: { configurable: true, get() { return Number.parseFloat(this.firstElementChild?.style.height ?? '') || 0; } },
  });
  window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === 'object') this.scrollTop = options.top ?? this.scrollTop;
  };
  const { PiFileChangePreview, PiFileChangePreviewScope } = await import('./PiFileChangePreview');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (count: number, phase: FileChangePhase = 'generating', key = 'live') => {
    const file = projectFileChanges({ type: 'toolCall', id: 'call', name: 'apply_patch', arguments: {
      patch: `*** Begin Patch\n*** Add File: a.ts\n${Array.from({ length: count }, (_, index) => `+const line${index} = ${index};`).join('\n')}\n*** End Patch`,
    } })[0]!;
    await act(async () => root.render(<I18nProvider><PiFileChangePreviewScope>
      <PiFileChangePreview key={key} previewId="call:a.ts" file={file} phase={phase} />
    </PiFileChangePreviewScope></I18nProvider>));
  };
  const viewport = () => container.querySelector<HTMLElement>('[role="region"]')!;
  const click = async (label: string) => {
    await act(async () => {
      const button = [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
      expect(button).toBeDefined();
      button.click();
    });
  };
  try {
    await render(20);
    expect(container.textContent).toContain('Preparing changes');
    expect(viewport().scrollTop).toBe(20 * 22 - 176);
    await act(async () => {
      viewport().scrollTop = 44;
      viewport().dispatchEvent(new window.Event('scroll'));
    });
    await render(24);
    expect(viewport().scrollTop).toBe(44);
    expect(container.textContent).toContain('Back to latest');
    await click('Expand changes');
    await render(25, 'applying', 'saved');
    expect(container.querySelector('[aria-label="Collapse preview"]')).not.toBeNull();
    expect(viewport().scrollTop).toBe(44);
    await click('Back to latest');
    expect(viewport().scrollTop).toBe(25 * 22 - 176);
    await render(30, 'failed', 'saved');
    expect(container.textContent).toContain('Not applied');
    expect(container.querySelectorAll('[data-change-kind]').length).toBeLessThan(30);
    expect(container.textContent).not.toContain('Applying changes');
  } finally {
    await act(async () => root.unmount());
  }
});
