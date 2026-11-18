import type { ThreadIdentity } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
import type { DocumentIdentity } from '@/lib/documents/types';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { openFileInMainEditor } from '@/lib/openFileInMainEditor';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { openWorkbenchEditor, patchEditorViewState, peekEditorWorkbench } from '@/lib/workbench/editors/session';
import { openProjectResourceFile } from '@/lib/workbench/editors/resource-workspace';
import { createLegacyTextEditorViewState } from '@/lib/workbench/editors/view-state-core';
import type { EditorSessionLink } from './types';
import { getVarinExtensionCatalogState } from '@/lib/extensions/catalog-store';
import { resolveVarinWorkbenchLayout, VARIN_WORKBENCH_IDE_PROFILE_ID } from '@varin/extension-contract';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { useUIStore } from '@/stores/useUIStore';

const byResource = new Map<string, EditorSessionLink>();

const keyOf = (identity: DocumentIdentity): string => `${identity.workspaceId}\0${identity.resourceId}`;

const rememberEditorSessionLink = (link: EditorSessionLink): void => {
  byResource.set(keyOf(link.identity), link);
};

export const peekEditorSessionLink = (identity: DocumentIdentity): EditorSessionLink | undefined => (
  byResource.get(keyOf(identity))
);

export const revealResourceInEditor = (input: {
  workspaceId: string;
  resourceId: string;
  workspaceRoot: string;
  resourceOwner?: SourceResourceOwner | undefined;
  line?: number;
  column?: number;
  thread?: ThreadIdentity;
  entryId?: string;
  toolCallId?: string;
}): void => {
  const path = workspacePathFromResourceId(input.workspaceRoot, input.resourceId);
  const workbenchLayout = getVarinExtensionCatalogState().snapshot?.workbench;
  const inAgent = workbenchLayout?.authoritative && resolveVarinWorkbenchLayout(workbenchLayout.document, {
    surface: varinSurfaceRuntime.surface, userId: 'default',
  }).profileId !== VARIN_WORKBENCH_IDE_PROFILE_ID;
  const remember = (workspaceId: string) => {
    if (!input.thread) return;
    const link: EditorSessionLink = { identity: { workspaceId, resourceId: input.resourceId }, thread: input.thread };
    if (input.entryId) link.entryId = input.entryId;
    if (input.toolCallId) link.toolCallId = input.toolCallId;
    rememberEditorSessionLink(link);
  };
  if (input.resourceOwner?.kind === 'managed_host') {
    const opened = openProjectResourceFile({ resourceOwner: input.resourceOwner, root: input.workspaceRoot, workspaceId: input.workspaceId }, input.resourceId, {
      target: inAgent ? 'context' : 'editor', preview: true,
      ...(input.line ? { viewState: createLegacyTextEditorViewState({ cursorLine: input.line, ...(input.column ? { cursorColumn: input.column } : {}) }) } : {}),
    });
    remember(opened.workspaceId);
    return;
  }
  remember(input.workspaceId);
  if (inAgent) {
    const opened = openWorkbenchEditor(input.workspaceId, input.resourceId, undefined, { preview: true });
    const tab = activeEditorTab(opened);
    useUIStore.getState().openContextPanelTab(input.workspaceRoot, {
      mode: 'file', targetPath: path, targetDirectory: input.workspaceRoot,
      ...(tab ? { editorViewId: tab.viewId } : {}),
    });
  }
  const openedInMain = inAgent || openFileInMainEditor(input.workspaceRoot, path, {
    ...(typeof input.line === 'number' ? { line: input.line } : {}),
    ...(typeof input.column === 'number' ? { column: input.column } : {}),
    focus: true,
  });
  if (!openedInMain) openWorkbenchEditor(input.workspaceId, input.resourceId);
  const workbench = peekEditorWorkbench(input.workspaceId);
  const active = workbench ? activeEditorTab(workbench) : undefined;
  if (active?.resourceId === input.resourceId && input.line) {
    patchEditorViewState(input.workspaceId, active.viewId, createLegacyTextEditorViewState({
      cursorLine: input.line,
      ...(input.column ? { cursorColumn: input.column } : {}),
    }));
  }
};

export const resetEditorSessionLinks = (runtimeKey?: string): void => {
  if (runtimeKey && runtimeKey !== getRuntimeKey()) return;
  byResource.clear();
};
