import { expect, test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { VARIN_WORKBENCH_SLOT_CONTRACTS, type VarinWorkbenchEditorActionsSlotProps } from '@varin/extension-contract';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
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


test('the actual editor action slot passes the declared public props to its contribution', async () => {
  const slot = VARIN_WORKBENCH_SLOT_CONTRACTS.editorActions;
  const owner = {
    desiredRevision: 1, entrypointId: 'main', extensionId: 'dev.contract.editor', extensionVersion: '1.0.0',
    generation: 1, hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078', realmId: 'editor-contract-test',
  };
  const received: VarinWorkbenchEditorActionsSlotProps[] = [];
  await varinSurfaceRuntime.activate({ owner }, (context) => context.contribute({
    contractVersion: slot.version, data: {}, id: 'dev.contract.editor.action', kind: 'view',
    placement: { slot: slot.id }, supports: ['web'],
  }, {
    render(props: VarinWorkbenchEditorActionsSlotProps) { received.push(props); return null; },
  }));
  try {
    const render = (selectedGroup: EditorGroupLeaf) => renderToStaticMarkup(
      <I18nProvider>
        <EditorGroupTabs
          group={selectedGroup}
          workspaceId="workspace-editor"
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
    render(group);
    render({ ...group, tabs: [], activeTabId: null });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ workspaceId: 'workspace-editor', groupId: group.groupId,
      resourceId: group.tabs[0]?.resourceId, viewId: group.tabs[0]?.viewId });
    for (const props of received) {
      for (const key of slot.propsSchema.required) expect(props).toHaveProperty(key);
      for (const [key, value] of Object.entries(props)) {
        expect(slot.propsSchema.properties).toHaveProperty(key);
        expect(typeof value).toBe(slot.propsSchema.properties[key]?.type);
      }
    }
  } finally {
    await varinSurfaceRuntime.deactivate(owner);
  }
});
