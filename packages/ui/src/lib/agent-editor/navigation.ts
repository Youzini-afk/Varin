import type { DocumentIdentity } from '@/lib/documents/types';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { openFileInMainEditor } from '@/lib/openFileInMainEditor';
import { getRuntimeKey } from '@varin/application-client';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { openWorkbenchEditor, patchEditorViewState, peekEditorWorkbench } from '@/lib/workbench/editors/session';
import { createLegacyTextEditorViewState } from '@/lib/workbench/editors/view-state-core';
import type { EditorSessionLink } from './types';
import { getVarinExtensionCatalogState } from '@/lib/extensions/catalog-store';
import { resolveVarinWorkbenchLayout, VARIN_WORKBENCH_IDE_PROFILE_ID } from '@varin/extension-contract';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { useUIStore } from '@/stores/useUIStore';

const byResource = new Map<string, EditorSessionLink>();

const keyOf = (identity: DocumentIdentity): string => `${identity.workspaceId}\0${identity.resourceId}`;

const rememberEditorSessionLink = (link: EditorSessionLink): void => {
  if (link.sessionId === '') return;
  byResource.set(keyOf(link.identity), link);
};

export const peekEditorSessionLink = (identity: DocumentIdentity): EditorSessionLink | undefined => (
  byResource.get(keyOf(identity))
);

export const revealResourceInEditor = (input: {
  workspaceId: string;
  resourceId: string;
  workspaceRoot: string;
  line?: number;
  column?: number;
  sessionId?: string;
  entryId?: string;
  toolCallId?: string;
}): void => {
  const identity = { workspaceId: input.workspaceId, resourceId: input.resourceId };
  if (input.sessionId) {
    const link: EditorSessionLink = { identity, sessionId: input.sessionId };
    if (input.entryId) link.entryId = input.entryId;
    if (input.toolCallId) link.toolCallId = input.toolCallId;
    rememberEditorSessionLink(link);
  }
  const path = workspacePathFromResourceId(input.workspaceRoot, input.resourceId);
  const workbenchLayout = getVarinExtensionCatalogState().snapshot?.workbench;
  const inAgent = workbenchLayout?.authoritative && resolveVarinWorkbenchLayout(workbenchLayout.document, {
    surface: varinSurfaceRuntime.surface, userId: 'default',
  }).profileId !== VARIN_WORKBENCH_IDE_PROFILE_ID;
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
