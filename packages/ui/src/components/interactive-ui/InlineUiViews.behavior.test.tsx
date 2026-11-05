import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { InlineUiSlot, InlineUiViews } from './InlineUiViews';
import { notifyUiSessions, uiSession } from '@/lib/interactive-ui/sessions';
import { clearUiInlinePlacement, uiInlineAnchor } from '@/lib/interactive-ui/inline-placement';
let mounts = 0;
vi.mock('./InteractiveUiCard', () => ({ UiWorkView: () => { React.useEffect(() => { mounts++; }, []); return <iframe title="work" />; } }));
vi.mock('./DeclarativeUiContent', () => ({ DeclarativeUiContent: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
afterEach(() => { clearUiInlinePlacement(); vi.unstubAllGlobals(); });
it('keeps one iframe mounted as an explicit prose slot replaces a tool slot after editing ends', async () => {
  const { window, document } = parseHTML('<html><body><main></main></body></html>');
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 800, innerHeight: 600 })) vi.stubGlobal(name, value);
  vi.stubGlobal('getComputedStyle', () => ({ overflowX: 'visible', overflowY: 'visible' }));
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  Object.assign(window.HTMLElement.prototype, { getBoundingClientRect: () => ({ top: 20, left: 10, right: 610, bottom: 120, width: 600, height: 100 }) });
  const root = createRoot(document.querySelector('main')!), session = uiSession('inline-test:work', { runtime: 'agent', threadId: 'inline-test', branchId: 'main' }, 0);
  session.display = { source: { ref: 'ui:test@1' }, files: {}, assets: {}, entry: 'index.html', title: 'Work', committed: true, status: '' };
  mounts = 0;
  const render = (embed: boolean) => root.render(<><InlineUiSlot session={session} anchorKey="tool" kind="tool" />{embed && <InlineUiSlot session={session} anchorKey="prose" kind="embed" />}<InlineUiViews prefix="inline-test:" /></>);
  try {
    await act(async () => render(false));
    const original = document.querySelector('iframe'); expect(original).not.toBeNull(); expect(mounts).toBe(1);
    session.interacting = true; session.inlineTarget = 'prose';
    await act(async () => { render(true); notifyUiSessions(); });
    expect(uiInlineAnchor(session)?.key).toBe('tool'); expect(document.querySelectorAll('iframe')).toHaveLength(1);
    session.interacting = false;
    await act(async () => notifyUiSessions());
    expect(uiInlineAnchor(session)?.key).toBe('prose'); expect(document.querySelector('iframe')).toBe(original); expect(mounts).toBe(1);
  } finally { act(() => root.unmount()); }
});
