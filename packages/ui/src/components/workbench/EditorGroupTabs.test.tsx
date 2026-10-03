import { expect, test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { EditorGroupLeaf } from '@/lib/workbench/editors/types';
import { EditorGroupTabs } from './EditorGroupTabs';

const group: EditorGroupLeaf = {
  type: 'group',
  groupId: 'group-1',
  activeTabId: 'tab-1',
  tabs: [{
    tabId: 'tab-1',
    viewId: 'view-1',
    resourceId: 'src/main.ts',
    preview: false,
    pinned: false,
    providerId: 'varin.builtin.text',
    viewState: {},
  }],
};

test('desktop editor tabs expose close directly instead of a more-actions trigger', () => {
  const markup = renderToStaticMarkup(
    <I18nProvider>
      <EditorGroupTabs
        group={group}
        workspaceRoot="/workspace"
        dirtyResourceIds={new Set()}
        isActiveGroup
        alwaysShowActions={false}
        isMobile={false}
        onActivate={() => undefined}
        onClose={() => undefined}
        onPin={() => undefined}
      />
    </I18nProvider>,
  );

  expect(markup).toContain('aria-label="Close main.ts"');
  expect(markup).toContain('href="#oc-close"');
  expect(markup).not.toContain('href="#oc-more-2-fill"');
});
