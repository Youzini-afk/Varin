import React from 'react';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { activeEditorTab, listEditorGroups } from '@/lib/workbench/editors/groups';
import { peekEditorWorkbench, subscribeEditorViewState } from '@/lib/workbench/editors/session';
import { useDocumentMeta } from '@/lib/documents/hooks';
import { useI18n } from '@/lib/i18n';

/** Read-only projection of the active view and its document; it never creates an editor. */
export function IdeEditorStatus({ workspaceId }: { workspaceId?: string }) {
  const { t } = useI18n();
  const workbench = useEditorWorkbench(workspaceId);
  const tab = workbench ? activeEditorTab(workbench) : undefined;
  const resourceId = tab?.resourceId;
  const viewId = tab?.viewId;
  const identity = React.useMemo(() => workspaceId && resourceId ? ({ workspaceId, resourceId }) : undefined, [workspaceId, resourceId]);
  const document = useDocumentMeta(identity);
  const info = React.useSyncExternalStore(subscribeEditorViewState, () => {
    const state = peekEditorWorkbench(workspaceId);
    return state ? listEditorGroups(state.tree).flatMap(group => group.tabs).find(candidate => candidate.viewId === viewId)?.viewState.editorInfo : undefined;
  }, () => undefined);
  if (!tab) return null;
  return <div className="ide-editor-status ml-auto flex min-w-0 items-center gap-3 overflow-hidden tabular-nums">
    {document?.dirty ? <span className="shrink-0 text-foreground/80">{t('workbench.panel.changesDirty')}</span> : null}
    {info ? <>
      <span className="shrink-0">{t('workbench.editor.cursor', { line: info.line, column: info.column })}</span>
      <span className="shrink-0">{info.languageName ?? info.languageId}</span>
      <span className="ide-editor-indent shrink-0">{info.insertSpaces ? t('workbench.editor.indentSpaces', { count: info.tabSize }) : t('workbench.editor.indentTabs')}</span>
    </> : null}
    {document?.encoding ? <span className="shrink-0">{document.encoding.toUpperCase()}{document.bom ? ' BOM' : ''}</span> : null}
    {document?.lineEnding ? <span className="ide-editor-eol shrink-0">{document.lineEnding.toUpperCase()}</span> : null}
  </div>;
}
