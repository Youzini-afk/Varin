import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { EmbeddedUiContent } from './EmbeddedUiContent';
import { UiEmbedAncestryContext } from '@/lib/interactive-ui/embed-ancestry';
const restore = vi.hoisted(() => vi.fn());
vi.mock('@/lib/interactive-ui/work-projection', () => ({ restoreUiWork: restore }));
vi.mock('./InlineUiViews', () => ({ InlineUiSlot: () => null }));
vi.mock('./UiRevisionLink', () => ({ UiRevisionLink: () => null }));
vi.mock('./InteractiveUiCard', () => ({ UiWorkView: () => null }));
vi.mock('./DeclarativeUiContent', () => ({ DeclarativeUiContent: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
it('keeps a circular embed readable without registering or recursively fetching it', async () => {
  const { document, window } = parseHTML('<html><body><main></main></body></html>');
  for (const [name, value] of Object.entries({ document, window, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  const root = createRoot(document.querySelector('main')!);
  try {
    await act(async () => root.render(<UiEmbedAncestryContext.Provider value={['ui:parent@1', 'ui:child@2']}><EmbeddedUiContent refValue="ui:parent@1" sourceKey="child:offset:0" /></UiEmbedAncestryContext.Provider>));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('ui:parent@1'); expect(restore).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
