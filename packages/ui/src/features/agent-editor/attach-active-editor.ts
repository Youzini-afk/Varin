import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import { addEditorContextAttachment } from '@/lib/agent-editor/attachments';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { getDocumentRegistry } from '@/lib/documents/session';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';
import { useEditorContextStore } from '@/stores/useEditorContextStore';

const resourceIdFor = (workspaceRoot: string, filePath: string, relativePath: string): string => (
  resourceIdFromWorkspacePath(workspaceRoot, filePath) ?? relativePath.replace(/\\/g, '/')
);

export const attachActiveEditorContext = (input: {
  threadKey: string;
  workspaceId: string;
  workspaceRoot: string;
  kind: 'editor' | 'selection';
}): EditorContextAttachment | { status: 'wrong-runtime' | 'missing-editor' | 'missing-selection' | 'missing-document' } => {
  const file = useEditorContextStore.getState().activeEditorFile;
  if (
    !file
    || file.runtimeKey !== getRuntimeKey()
    || (file.workspaceId !== null && file.workspaceId !== input.workspaceId)
  ) {
    return { status: 'missing-editor' };
  }
  const resourceId = resourceIdFor(input.workspaceRoot, file.filePath, file.relativePath);
  const current = getDocumentRegistry().get({ workspaceId: input.workspaceId, resourceId });
  if (file.workspaceId !== null && current && current.documentInstanceId !== file.documentInstanceId) {
    return { status: 'missing-document' };
  }
  if (input.kind === 'selection') {
    if (!file.selection) return { status: 'missing-selection' };
    const fromRegistry = attachEditorContext({
      threadKey: input.threadKey,
      workspaceId: input.workspaceId,
      resourceId,
      kind: 'selection',
      range: {
        startLine: file.selection.startLine,
        startColumn: file.selection.startColumn ?? 1,
        endLine: file.selection.endLine,
        endColumn: file.selection.endColumn ?? 1,
      },
      label: file.relativePath,
      text: file.selection.text,
    });
    if (!('status' in fromRegistry) || fromRegistry.status !== 'missing-document') return fromRegistry;
    return addEditorContextAttachment({
      id: crypto.randomUUID(),
      runtimeKey: getRuntimeKey(),
      threadKey: input.threadKey,
      workspaceId: input.workspaceId,
      resourceId,
      label: file.relativePath,
      documentInstanceId: file.documentInstanceId,
      documentRevision: null,
      localEditRevision: 0,
      source: 'unsaved-buffer',
      kind: 'selection',
      range: {
        startLine: file.selection.startLine,
        startColumn: file.selection.startColumn ?? 1,
        endLine: file.selection.endLine,
        endColumn: file.selection.endColumn ?? 1,
      },
      languageId: languageIdFromResourceId(resourceId),
      text: file.selection.text,
    });
  }
  const fromRegistry = attachEditorContext({
    threadKey: input.threadKey,
    workspaceId: input.workspaceId,
    resourceId,
    kind: 'editor',
    label: file.relativePath,
  });
  if (!('status' in fromRegistry) || fromRegistry.status !== 'missing-document') return fromRegistry;
  return addEditorContextAttachment({
    id: crypto.randomUUID(),
    runtimeKey: getRuntimeKey(),
    threadKey: input.threadKey,
    workspaceId: input.workspaceId,
    resourceId,
    label: file.relativePath,
    documentInstanceId: file.documentInstanceId,
    documentRevision: null,
    localEditRevision: 0,
    source: 'saved',
    kind: 'editor',
    languageId: languageIdFromResourceId(resourceId),
  });
};
