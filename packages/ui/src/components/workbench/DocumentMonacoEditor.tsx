import React from 'react';
import { createPortal } from 'react-dom';
import type { editor as MonacoEditor } from 'monaco-editor/editor';

import { Button } from '@/components/ui/button';
import { InlineCommentInput } from '@/components/comments/InlineCommentInput';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';
import { cn } from '@/lib/utils';
import type { EditorViewState } from '@/lib/workbench/editors/types';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import {
  activatePiEditorContextOwner,
  publishPiEditorContext,
  releasePiEditorContextOwner,
} from '@/stores/usePiEditorContextStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRuntimeKey } from '@varin/application-client';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  EMPTY_INLINE_COMMENT_DRAFTS,
  getInlineCommentDraftKey,
  useInlineCommentDraftStore,
} from '@/stores/useInlineCommentDraftStore';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { createRunDebugEditorAdapter } from '@/lib/monaco/run-debug-editor-adapter';
import { getMonacoLanguageBridge } from '@/lib/monaco/language-bridge-session';
import { getFileEditorModelRegistry } from '@/lib/monaco/model-session';
import { markMonacoPerformance } from '@/lib/monaco/performance';
import { loadMonacoRuntime, type MonacoRuntime } from '@/lib/monaco/runtime';
import { registerVarinMonacoTheme } from '@/lib/monaco/theme';
import { applyMonacoEditorViewState, captureMonacoEditorViewState } from '@/lib/monaco/view-state';
import { createVarinMonacoVimAdapter } from '@/lib/monaco/vim-adapter';
import { applyMonacoModelSettings, createMonacoEditorOptions } from '@/lib/monaco/editor-options';
import {
  FILE_EDITOR_COMMAND_IDS,
  registerFileEditorCommandTarget,
  saveFileEditorDocument,
} from '@/lib/monaco/editor-command-service';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { languageIdsFromResourceId, languageIdFromResourceId } from '@/lib/language-services/language-id';
import { registerMonacoExtensionView } from '@/lib/monaco/extension-service';
import {
  peekLanguageProviderStatus,
  subscribeLanguageProviderStatus,
} from '@/lib/language-services/provider-status-registry';

type DocumentMonacoEditorProps = {
  className?: string;
  identity: DocumentIdentity;
  onViewStateChange?(viewState: EditorViewState): void;
  path: string;
  providerId: string;
  viewId: string;
  viewState: EditorViewState;
};

type PendingInlineComment = {
  code: string;
  endLine: number;
  node: HTMLDivElement;
  startLine: number;
};

export const DocumentMonacoEditor: React.FC<DocumentMonacoEditorProps> = ({
  className,
  identity,
  onViewStateChange,
  path,
  providerId,
  viewId,
  viewState,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const fileEditorSettings = useUIStore((state) => state.fileEditorSettings);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const updateFileEditorSettings = useUIStore((state) => state.updateFileEditorSettings);
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const sessionDirectory = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId]?.snapshot?.cwd ?? null : null
  ));
  const inlineDraftKey = sessionId && sessionDirectory
    ? getInlineCommentDraftKey(getRuntimeKey(), sessionDirectory, sessionId)
    : null;
  const inlineDrafts = useInlineCommentDraftStore((state) => (
    inlineDraftKey ? state.drafts[inlineDraftKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS
  ));
  const profileId = useWorkbenchProfileId();
  const [monaco, setMonaco] = React.useState<MonacoRuntime | null>(null);
  const [editorInstance, setEditorInstance] = React.useState<import('monaco-editor/editor').editor.IStandaloneCodeEditor | null>(null);
  const [pendingInlineComment, setPendingInlineComment] = React.useState<PendingInlineComment | null>(null);
  const hostLanguageId = React.useMemo(() => (
    monaco
      ? languageIdsFromResourceId(identity.resourceId, monaco.languages.getLanguages()).hostLanguageId
      : languageIdFromResourceId(identity.resourceId)
  ), [identity.resourceId, monaco]);
  const languageStatus = React.useSyncExternalStore(
    subscribeLanguageProviderStatus,
    () => peekLanguageProviderStatus(identity.workspaceId, hostLanguageId),
    () => undefined,
  );
  const record = useDocumentRecord(identity);
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const vimStatusRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<import('monaco-editor/editor').editor.IStandaloneCodeEditor | null>(null);
  const viewStateRef = React.useRef(viewState);
  const onViewStateChangeRef = React.useRef(onViewStateChange);
  const recordRef = React.useRef(record);
  const tRef = React.useRef(t);
  const captureContextRef = React.useRef<(() => void) | null>(null);
  const closeInlineCommentRef = React.useRef<(() => void) | null>(null);
  const inlineCommentDecorationIdsRef = React.useRef<string[]>([]);
  const models = getFileEditorModelRegistry();
  const instanceOwner = React.useId();
  const ownerId = `view:${viewId}:${instanceOwner}`;

  viewStateRef.current = viewState;
  onViewStateChangeRef.current = onViewStateChange;
  recordRef.current = record;
  tRef.current = t;

  React.useEffect(() => {
    if (hostRef.current?.closest('[data-varin-workbench-shell-staging]')) return;
    models.acquire(identity, ownerId);
    return () => models.release(ownerId);
  }, [identity, models, ownerId]);

  const modelSnapshot = React.useSyncExternalStore(
    React.useCallback((listener) => models.subscribe(identity, listener), [identity, models]),
    React.useCallback(() => models.getSnapshot(identity), [identity, models]),
    React.useCallback(() => models.getSnapshot(identity), [identity, models]),
  );

  React.useEffect(() => {
    let cancelled = false;
    void loadMonacoRuntime().then((loaded) => {
      if (!cancelled) setMonaco(loaded);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!monaco) return;
    const themeName = registerVarinMonacoTheme(monaco, currentTheme);
    monaco.editor.setTheme(themeName);
  }, [currentTheme, monaco]);

  React.useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    applyMonacoModelSettings(editorInstance.getModel()!, fileEditorSettings);
    editorInstance.updateOptions(createMonacoEditorOptions({
      ariaLabel: path,
      fontSize: editorFontSize,
      profileId,
      settings: fileEditorSettings,
    }));
  }, [editorFontSize, fileEditorSettings, path, profileId]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || host.closest('[data-varin-workbench-shell-staging]') || !monaco || modelSnapshot.status !== 'ready') return undefined;
    const themeName = registerVarinMonacoTheme(monaco, currentTheme);
    applyMonacoModelSettings(modelSnapshot.model, fileEditorSettings);
    const editorInstance = monaco.editor.create(host, {
      ...createMonacoEditorOptions({
        ariaLabel: path,
        fontSize: editorFontSize,
        profileId,
        settings: fileEditorSettings,
      }),
      model: modelSnapshot.model,
      theme: themeName,
    });
    editorRef.current = editorInstance;
    setEditorInstance(editorInstance);
    applyMonacoEditorViewState(editorInstance, viewStateRef.current);
    editorInstance.layout();

    const bridge = getMonacoLanguageBridge(monaco, models);
    const languageOwnerId = `language:${viewId}:${instanceOwner}`;
    bridge.acquire(modelSnapshot.model, identity, languageOwnerId);
    const runDebugAdapter = createRunDebugEditorAdapter({ editor: editorInstance, identity, monaco });
    const disposeExtensionView = registerMonacoExtensionView({
      editor: editorInstance,
      getDocumentVersion: () => recordRef.current?.localEditRevision ?? 0,
      identity,
      kind: 'text',
      providerId,
      viewId,
    });

    let captureFrame: number | null = null;
    const capture = (): void => {
      captureFrame = null;
      const languageName = monaco.languages.getLanguages().find(language => language.id === editorInstance.getModel()?.getLanguageId())?.aliases?.[0];
      const next = captureMonacoEditorViewState(editorInstance, languageName);
      if (onViewStateChangeRef.current) onViewStateChangeRef.current(next);
      else patchEditorViewState(identity.workspaceId, viewId, next);
      const selection = editorInstance.getSelection();
      const open = recordRef.current;
      const hasSelection = Boolean(selection && !selection.isEmpty());
      if (!open?.documentInstanceId) return;
      publishPiEditorContext(ownerId, {
        documentInstanceId: open.documentInstanceId,
        fileName: identity.resourceId.split('/').pop() || identity.resourceId,
        filePath: path,
        fileSize: open?.byteLength ?? null,
        relativePath: identity.resourceId,
        runtimeKey: getRuntimeKey(),
        selection: hasSelection && selection
          ? {
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
              text: modelSnapshot.model.getValueInRange(selection),
            }
          : null,
        dirty: open?.dirty === true,
        viewId,
        workspaceId: identity.workspaceId,
      });
    };
    captureContextRef.current = capture;
    const scheduleCapture = (): void => {
      if (captureFrame !== null) return;
      captureFrame = requestAnimationFrame(capture);
    };
    const closeInlineComment = (): void => {
      closeInlineCommentRef.current?.();
    };
    const openInlineComment = (): void => {
      closeInlineComment();
      const selection = editorInstance.getSelection();
      const model = editorInstance.getModel();
      if (!selection || !model) return;
      const startLine = selection.startLineNumber;
      const endLine = !selection.isEmpty() && selection.endColumn === 1 && selection.endLineNumber > startLine
        ? selection.endLineNumber - 1
        : selection.endLineNumber;
      const code = selection.isEmpty()
        ? model.getLineContent(startLine)
        : model.getValueInRange(selection);
      const node = document.createElement('div');
      node.className = 'w-[min(30rem,calc(100vw-4rem))] py-1';
      const widgetId = `varin.inline-comment.${viewId}`;
      const widget: MonacoEditor.IContentWidget = {
        allowEditorOverflow: true,
        getDomNode: () => node,
        getId: () => widgetId,
        getPosition: () => ({
          position: { lineNumber: endLine, column: model.getLineMaxColumn(endLine) },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.BELOW,
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
          ],
        }),
      };
      editorInstance.addContentWidget(widget);
      closeInlineCommentRef.current = () => {
        editorInstance.removeContentWidget(widget);
        node.remove();
        closeInlineCommentRef.current = null;
        setPendingInlineComment((current) => current?.node === node ? null : current);
      };
      setPendingInlineComment({ code, endLine, node, startLine });
    };
    const disposables = [
      editorInstance.onDidChangeCursorSelection(scheduleCapture),
      editorInstance.onDidScrollChange(scheduleCapture),
      editorInstance.onDidChangeHiddenAreas(scheduleCapture),
      editorInstance.onDidFocusEditorWidget(() => {
        activatePiEditorContextOwner(ownerId);
        scheduleCapture();
      }),
      editorInstance.addAction({
        id: 'varin.editor.addInlineComment',
        label: tRef.current('inlineComment.actions.comment'),
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 20,
        run: openInlineComment,
      }),
    ];
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => editorInstance.layout())
      : null;
    resizeObserver?.observe(host);
    const handleWindowResize = (): void => editorInstance.layout();
    if (!resizeObserver) window.addEventListener('resize', handleWindowResize);
    capture();
    void Promise.resolve(editorInstance.renderAsync()).then(() => markMonacoPerformance('editor.first.paint'));

    return () => {
      if (captureFrame !== null) cancelAnimationFrame(captureFrame);
      capture();
      captureContextRef.current = null;
      releasePiEditorContextOwner(ownerId);
      closeInlineCommentRef.current?.();
      bridge.release(languageOwnerId);
      runDebugAdapter.dispose();
      disposeExtensionView();
      for (const disposable of disposables) disposable.dispose();
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', handleWindowResize);
      editorRef.current = null;
      setEditorInstance(null);
      editorInstance.dispose();
    };
    // Theme, profile presentation and settings update the live editor separately; none may recreate the view/model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, instanceOwner, modelSnapshot.status === 'ready' ? modelSnapshot.model : null, models, monaco, path, providerId, viewId]);

  React.useEffect(() => {
    captureContextRef.current?.();
  }, [record?.byteLength, record?.dirty, record?.documentInstanceId, record?.localEditRevision]);

  React.useEffect(() => {
    if (!editorInstance) return undefined;
    const relevant = inlineDrafts.filter((draft) => (
      draft.source === 'editor-selection'
      && draft.fileLabel.replace(/\\/g, '/') === identity.resourceId.replace(/\\/g, '/')
    ));
    inlineCommentDecorationIdsRef.current = editorInstance.deltaDecorations(
      inlineCommentDecorationIdsRef.current,
      relevant.map((draft) => ({
        range: {
          startLineNumber: Math.min(draft.startLine, editorInstance.getModel()?.getLineCount() ?? draft.startLine),
          startColumn: 1,
          endLineNumber: Math.min(draft.endLine, editorInstance.getModel()?.getLineCount() ?? draft.endLine),
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: 'varin-editor-inline-comment-line',
          glyphMarginClassName: 'varin-editor-inline-comment-glyph',
        },
      })),
    );
    return () => {
      if (editorInstance.getModel()) {
        inlineCommentDecorationIdsRef.current = editorInstance.deltaDecorations(
          inlineCommentDecorationIdsRef.current,
          [],
        );
      } else {
        inlineCommentDecorationIdsRef.current = [];
      }
    };
  }, [editorInstance, identity.resourceId, inlineDrafts]);

  React.useEffect(() => {
    if (!monaco || !editorInstance) return undefined;
    return registerFileEditorCommandTarget({
      editor: editorInstance,
      identity,
      ownerId,
      getSettings: () => useUIStore.getState().fileEditorSettings,
      getShortcutOverrides: () => useUIStore.getState().shortcutOverrides,
      updateSettings: updateFileEditorSettings,
      onCommandError: (commandId, error) => {
        toast.error(commandId === FILE_EDITOR_COMMAND_IDS.save
          ? t('filesView.toast.saveFailed')
          : t('common.unavailable'), {
          description: error instanceof Error ? error.message : String(error),
        });
      },
      onCommandUnavailable: () => toast.message(t('common.unavailable')),
      viewId,
    });
  }, [
    editorInstance,
    identity,
    monaco,
    ownerId,
    t,
    updateFileEditorSettings,
    viewId,
  ]);

  React.useEffect(() => {
    const statusNode = vimStatusRef.current;
    if (!monaco || !editorInstance || !statusNode || fileEditorKeymap !== 'vim') return undefined;
    const adapter = createVarinMonacoVimAdapter({
      commandAriaLabel: t('settings.varin.visual.field.fileEditorKeymap'),
      editor: editorInstance,
      monaco,
      onSave: () => {
        void saveFileEditorDocument(identity).catch((error) => {
          console.error('[Editor] Save failed:', error);
        });
      },
      statusNode,
    });
    return () => adapter.dispose();
  }, [editorInstance, fileEditorKeymap, identity, monaco, t]);

  if (modelSnapshot.status === 'failed') {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-4 text-center', className)}>
        <p className="typography-ui text-status-error">{modelSnapshot.errorMessage}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => models.retry(identity)}>
          {t('startup.initRecovery.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {modelSnapshot.status === 'ready' && modelSnapshot.syncFailure ? (
        <div className="shrink-0 border-b border-status-warning/40 bg-status-warning/10 px-3 py-1.5 typography-meta text-status-warning">
          {t('filesView.editor.syncRecovered')}
        </div>
      ) : null}
      {languageStatus?.status === 'starting' ? (
        <div className="shrink-0 border-b border-border/50 bg-muted/20 px-3 py-1 typography-meta text-muted-foreground">
          {t('filesView.editor.languageStarting')}
        </div>
      ) : languageStatus?.status === 'degraded' ? (
        <div className="shrink-0 border-b border-status-warning/40 bg-status-warning/10 px-3 py-1 typography-meta text-status-warning">
          {t('filesView.editor.languageDegraded', { message: languageStatus.message })}
        </div>
      ) : languageStatus?.status === 'failed' ? (
        <div className="shrink-0 border-b border-status-error/40 bg-status-error/10 px-3 py-1 typography-meta text-status-error">
          {t('filesView.editor.languageFailed', { message: languageStatus.message })}
        </div>
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
      {pendingInlineComment ? createPortal(
        <InlineCommentInput
          fileLabel={identity.resourceId}
          lineRange={{ start: pendingInlineComment.startLine, end: pendingInlineComment.endLine }}
          onCancel={() => closeInlineCommentRef.current?.()}
          onSave={(text) => {
            if (!sessionId || !sessionDirectory) {
              toast.error(t('inlineComment.toast.selectSessionToSave'));
              return;
            }
            const sessionResourceId = resourceIdFromWorkspacePath(sessionDirectory, path);
            if (sessionResourceId === null) {
              toast.error(t('inlineComment.toast.selectSessionToSave'));
              return;
            }
            const accepted = useInlineCommentDraftStore.getState().addDraft(
              { directory: sessionDirectory, sessionKey: sessionId },
              {
                source: 'editor-selection',
                fileLabel: sessionResourceId,
                startLine: pendingInlineComment.startLine,
                endLine: pendingInlineComment.endLine,
                language: hostLanguageId,
                code: pendingInlineComment.code,
                text,
              },
            );
            if (accepted) closeInlineCommentRef.current?.();
          }}
        />,
        pendingInlineComment.node,
      ) : null}
      <div
        ref={vimStatusRef}
        className={cn(
          'hidden h-6 shrink-0 items-center gap-2 border-t border-border/50 bg-muted/30 px-2 font-mono typography-micro text-muted-foreground',
          fileEditorKeymap === 'vim' && 'flex',
        )}
      />
    </div>
  );
};
