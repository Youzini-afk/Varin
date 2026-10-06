import React from 'react';
import type { editor } from 'monaco-editor/editor';
import type { JsonValue } from '@varin/extension-contract';
import { createTwoFilesPatch } from 'diff';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import type { DocumentIdentity } from '@/lib/documents/types';
import { languageIdsFromResourceId } from '@/lib/language-services/language-id';
import { getMonacoLanguageBridge } from '@/lib/monaco/language-bridge-session';
import {
  acquireMonacoDiffSnapshotModel,
  type MonacoDiffSnapshotModelHandle,
} from '@/lib/monaco/diff-model-registry';
import { applyMonacoModelSettings, createMonacoEditorOptions } from '@/lib/monaco/editor-options';
import { registerFileEditorCommandTarget } from '@/lib/monaco/editor-command-service';
import { getFileEditorModelRegistry } from '@/lib/monaco/model-session';
import { loadMonacoRuntime, type MonacoRuntime } from '@/lib/monaco/runtime';
import { registerVarinMonacoTheme } from '@/lib/monaco/theme';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import type { EditorViewState } from '@/lib/workbench/editors/types';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import {
  activatePiEditorContextOwner,
  publishPiEditorContext,
  releasePiEditorContextOwner,
} from '@/stores/usePiEditorContextStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRuntimeKey } from '@varin/application-client';
import { cn } from '@/lib/utils';
import { createRunDebugEditorAdapter } from '@/lib/monaco/run-debug-editor-adapter';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { registerMonacoExtensionView } from '@/lib/monaco/extension-service';

type MonacoFileDiffEditorProps = {
  className?: string;
  identity: DocumentIdentity;
  modifiedContent?: string;
  modifiedRevision?: string;
  onViewStateChange?(viewState: EditorViewState): void;
  originalContent: string;
  originalRevision: string;
  path: string;
  providerId: string;
  readOnly: boolean;
  renderSideBySide?: boolean;
  viewId: string;
  viewState: EditorViewState;
  wrapLines?: boolean;
};

const EMPTY_LIVE_SNAPSHOT = { status: 'loading', model: null, syncFailure: null } as const;

const jsonClone = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const MonacoFileDiffEditor: React.FC<MonacoFileDiffEditorProps> = ({
  className,
  identity,
  modifiedContent,
  modifiedRevision,
  onViewStateChange,
  originalContent,
  originalRevision,
  path,
  providerId,
  readOnly,
  renderSideBySide,
  viewId,
  viewState,
  wrapLines,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const fileEditorSettings = useUIStore((state) => state.fileEditorSettings);
  const updateFileEditorSettings = useUIStore((state) => state.updateFileEditorSettings);
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const sessionDirectory = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId]?.snapshot?.cwd ?? null : null
  ));
  const profileId = useWorkbenchProfileId();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const instanceOwner = React.useId();
  const modelOwnerId = `diff-model:${viewId}:${instanceOwner}`;
  const contextOwnerId = `view:${viewId}`;
  const languageOwnerId = `diff-language:${viewId}:${instanceOwner}`;
  const [monaco, setMonaco] = React.useState<MonacoRuntime | null>(null);
  const [diffEditor, setDiffEditor] = React.useState<editor.IStandaloneDiffEditor | null>(null);
  const [originalHandle, setOriginalHandle] = React.useState<MonacoDiffSnapshotModelHandle | null>(null);
  const [modifiedHandle, setModifiedHandle] = React.useState<MonacoDiffSnapshotModelHandle | null>(null);
  const modelBinding = React.useRef<{
    editor: editor.IStandaloneDiffEditor;
    original: editor.ITextModel;
    modified: editor.ITextModel;
    dispose(): void;
  } | null>(null);
  const models = getFileEditorModelRegistry();
  const usesLiveDocument = modifiedContent === undefined;
  const onViewStateChangeRef = React.useRef(onViewStateChange);
  const viewStateRef = React.useRef(viewState);
  const sessionIdRef = React.useRef(sessionId);
  const sessionDirectoryRef = React.useRef(sessionDirectory);
  const tRef = React.useRef(t);
  onViewStateChangeRef.current = onViewStateChange;
  viewStateRef.current = viewState;
  sessionIdRef.current = sessionId;
  sessionDirectoryRef.current = sessionDirectory;
  tRef.current = t;

  React.useEffect(() => {
    let cancelled = false;
    void loadMonacoRuntime().then((runtime) => {
      if (!cancelled) setMonaco(runtime);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!usesLiveDocument) return undefined;
    models.acquire(identity, modelOwnerId);
    return () => {
      const snapshot = models.getSnapshot(identity);
      const binding = modelBinding.current;
      if (snapshot.status === 'ready' && binding?.modified === snapshot.model) binding.dispose();
      models.release(modelOwnerId);
    };
  }, [identity, modelOwnerId, models, usesLiveDocument]);

  const liveSnapshot = React.useSyncExternalStore(
    React.useCallback((listener) => (
      usesLiveDocument ? models.subscribe(identity, listener) : () => undefined
    ), [identity, models, usesLiveDocument]),
    React.useCallback(() => (
      usesLiveDocument ? models.getSnapshot(identity) : EMPTY_LIVE_SNAPSHOT
    ), [identity, models, usesLiveDocument]),
    () => EMPTY_LIVE_SNAPSHOT,
  );

  const monacoLanguageId = React.useMemo(() => (
    monaco
      ? languageIdsFromResourceId(identity.resourceId, monaco.languages.getLanguages()).monacoLanguageId
      : 'plaintext'
  ), [identity.resourceId, monaco]);

  React.useEffect(() => {
    if (!monaco) return undefined;
    const handle = acquireMonacoDiffSnapshotModel(monaco, {
      content: originalContent,
      languageId: monacoLanguageId,
      ownerId: `${modelOwnerId}:original`,
      revision: originalRevision,
      side: 'original',
      viewId,
    });
    setOriginalHandle(handle);
    return () => {
      if (modelBinding.current?.original === handle.model) modelBinding.current.dispose();
      setOriginalHandle((current) => current === handle ? null : current);
      handle.release();
    };
  }, [modelOwnerId, monaco, monacoLanguageId, originalContent, originalRevision, viewId]);

  React.useEffect(() => {
    if (!monaco || modifiedContent === undefined || !modifiedRevision) return undefined;
    const handle = acquireMonacoDiffSnapshotModel(monaco, {
      content: modifiedContent,
      languageId: monacoLanguageId,
      ownerId: `${modelOwnerId}:modified`,
      revision: modifiedRevision,
      side: 'modified',
      viewId,
    });
    setModifiedHandle(handle);
    return () => {
      if (modelBinding.current?.modified === handle.model) modelBinding.current.dispose();
      setModifiedHandle((current) => current === handle ? null : current);
      handle.release();
    };
  }, [modelOwnerId, modifiedContent, modifiedRevision, monaco, monacoLanguageId, viewId]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !monaco) return undefined;
    const theme = registerVarinMonacoTheme(monaco, currentTheme);
    const instance = monaco.editor.createDiffEditor(host, {
      ...createMonacoEditorOptions({
        ariaLabel: path,
        fontSize: editorFontSize,
        profileId,
        settings: fileEditorSettings,
      }),
      enableSplitViewResizing: true,
      originalEditable: false,
      readOnly,
      renderSideBySide: renderSideBySide ?? true,
      useInlineViewWhenSpaceIsLimited: renderSideBySide === undefined,
      renderSideBySideInlineBreakpoint: 720,
      theme,
      ...(wrapLines === undefined ? {} : { wordWrap: wrapLines ? 'on' : 'off' }),
    });
    setDiffEditor(instance);
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => instance.layout())
      : null;
    resizeObserver?.observe(host);
    const handleWindowResize = (): void => instance.layout();
    if (!resizeObserver) window.addEventListener('resize', handleWindowResize);
    instance.layout();
    return () => {
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', handleWindowResize);
      if (modelBinding.current?.editor === instance) modelBinding.current.dispose();
      setDiffEditor((current) => current === instance ? null : current);
      instance.dispose();
    };
    // Theme, profile and settings update the live instance below without rebuilding its models.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco, path, viewId]);

  React.useEffect(() => {
    if (!monaco || !diffEditor) return;
    monaco.editor.setTheme(registerVarinMonacoTheme(monaco, currentTheme));
    diffEditor.updateOptions({
      ...createMonacoEditorOptions({
        ariaLabel: path,
        fontSize: editorFontSize,
        profileId,
        settings: fileEditorSettings,
      }),
      originalEditable: false,
      readOnly,
      renderSideBySide: renderSideBySide ?? true,
      useInlineViewWhenSpaceIsLimited: renderSideBySide === undefined,
      renderSideBySideInlineBreakpoint: 720,
      ...(wrapLines === undefined ? {} : { wordWrap: wrapLines ? 'on' : 'off' }),
    });
  }, [currentTheme, diffEditor, editorFontSize, fileEditorSettings, monaco, path, profileId, readOnly, renderSideBySide, wrapLines]);

  const modifiedModel = usesLiveDocument
    ? liveSnapshot.status === 'ready' ? liveSnapshot.model : null
    : modifiedHandle?.model ?? null;

  React.useEffect(() => {
    if (!diffEditor || !monaco || !originalHandle?.model || !modifiedModel) return undefined;
    applyMonacoModelSettings(originalHandle.model, fileEditorSettings);
    applyMonacoModelSettings(modifiedModel, fileEditorSettings);
    diffEditor.setModel({ original: originalHandle.model, modified: modifiedModel });
    const persisted = viewStateRef.current.providerState;
    if (persisted?.providerId === providerId && persisted.schemaVersion === 1) {
      try {
        diffEditor.restoreViewState(persisted.value as unknown as editor.IDiffEditorViewState);
      } catch {
        // A provider view-state failure may reset the view, never the document models.
      }
    }
    const modifiedEditor = diffEditor.getModifiedEditor();
    const bridge = usesLiveDocument ? getMonacoLanguageBridge(monaco, models) : null;
    if (bridge) bridge.acquire(modifiedModel, identity, languageOwnerId);
    const runDebugAdapter = usesLiveDocument
      ? createRunDebugEditorAdapter({ editor: modifiedEditor, identity, monaco })
      : null;
    const disposeExtensionView = usesLiveDocument
      ? registerMonacoExtensionView({
          editor: modifiedEditor,
          getDocumentVersion: () => models.getRecordForModel(modifiedModel)?.localEditRevision ?? 0,
          identity,
          kind: 'diff-modified',
          providerId,
          viewId,
        })
      : () => undefined;
    const disposeCommandTarget = usesLiveDocument
      ? registerFileEditorCommandTarget({
          editor: modifiedEditor,
          identity,
          ownerId: modelOwnerId,
          getSettings: () => useUIStore.getState().fileEditorSettings,
          getShortcutOverrides: () => useUIStore.getState().shortcutOverrides,
          updateSettings: updateFileEditorSettings,
          viewId,
        })
      : () => undefined;
    let captureFrame: number | null = null;
    const capture = (): void => {
      captureFrame = null;
      const saved = diffEditor.saveViewState();
      if (saved) {
        const nextViewState: EditorViewState = {
          providerState: {
            providerId,
            schemaVersion: 1,
            value: jsonClone(saved),
          },
        };
        if (onViewStateChangeRef.current) onViewStateChangeRef.current(nextViewState);
        else patchEditorViewState(identity.workspaceId, viewId, nextViewState);
      }
      if (!usesLiveDocument) return;
      const selection = modifiedEditor.getSelection();
      const record = models.getRecordForModel(modifiedModel);
      if (!record?.documentInstanceId) return;
      publishPiEditorContext(contextOwnerId, {
        documentInstanceId: record.documentInstanceId,
        fileName: identity.resourceId.split('/').pop() || identity.resourceId,
        filePath: path,
        fileSize: record.byteLength,
        relativePath: identity.resourceId,
        runtimeKey: getRuntimeKey(),
        selection: selection && !selection.isEmpty()
          ? {
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
              text: modifiedModel.getValueInRange(selection),
            }
          : null,
        dirty: record.dirty,
        viewId,
        workspaceId: identity.workspaceId,
      });
    };
    const scheduleCapture = (): void => {
      if (captureFrame !== null) return;
      captureFrame = requestAnimationFrame(capture);
    };
    const disposables = [
      diffEditor.onDidUpdateDiff(scheduleCapture),
      modifiedEditor.onDidChangeCursorSelection(scheduleCapture),
      modifiedEditor.onDidScrollChange(scheduleCapture),
      modifiedEditor.onDidFocusEditorWidget(() => {
        activatePiEditorContextOwner(contextOwnerId);
        scheduleCapture();
      }),
      modifiedEditor.addAction({
        id: 'varin.editor.attachDiff',
        label: tRef.current('workbench.attachment.attachDiff'),
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 21,
        run: () => {
          const currentSessionId = sessionIdRef.current;
          const currentDirectory = sessionDirectoryRef.current;
          if (
            !currentSessionId
            || !currentDirectory
            || resourceIdFromWorkspacePath(currentDirectory, path) === null
          ) {
            toast.error(tRef.current('workbench.attachment.no-session'));
            return;
          }
          const result = attachEditorContext({
            sessionId: currentSessionId,
            workspaceId: identity.workspaceId,
            resourceId: identity.resourceId,
            kind: 'diff',
            label: identity.resourceId,
            patch: createTwoFilesPatch(
              identity.resourceId,
              identity.resourceId,
              originalHandle.model.getValue(),
              modifiedModel.getValue(),
              'original',
              'modified',
            ),
          });
          if ('status' in result) {
            toast.error(tRef.current(
              result.status === 'wrong-runtime'
                ? 'workbench.attachment.wrong-runtime'
                : 'workbench.attachment.missing-document',
            ));
          }
        },
      }),
    ];
    // A lease cleanup may run before this effect's cleanup. Keep one idempotent
    // binding teardown so its view state and listeners are settled before either model is released.
    let disposed = false;
    const binding = {
      editor: diffEditor,
      original: originalHandle.model,
      modified: modifiedModel,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        if (modelBinding.current === binding) modelBinding.current = null;
        if (captureFrame !== null) cancelAnimationFrame(captureFrame);
        capture();
        releasePiEditorContextOwner(contextOwnerId);
        disposeExtensionView();
        disposeCommandTarget();
        runDebugAdapter?.dispose();
        if (bridge) bridge.release(languageOwnerId);
        for (const disposable of disposables) disposable.dispose();
        diffEditor.setModel(null);
      },
    };
    modelBinding.current = binding;
    capture();
    return binding.dispose;
  }, [
    contextOwnerId,
    diffEditor,
    fileEditorSettings,
    identity,
    languageOwnerId,
    modelOwnerId,
    models,
    modifiedModel,
    monaco,
    originalHandle,
    path,
    providerId,
    updateFileEditorSettings,
    usesLiveDocument,
    viewId,
  ]);

  const failure = usesLiveDocument && liveSnapshot.status === 'failed'
    ? liveSnapshot.errorMessage
    : null;

  return (
    <div className={cn('relative h-full min-h-0 overflow-hidden', className)}>
      <div ref={hostRef} className="h-full min-h-0" />
      {!originalHandle || !modifiedModel ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/90 typography-ui text-muted-foreground">
          {failure ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="text-status-error">{failure}</span>
              {usesLiveDocument ? (
                <Button type="button" variant="outline" size="sm" onClick={() => models.retry(identity)}>
                  {t('startup.initRecovery.retry')}
                </Button>
              ) : null}
            </div>
          ) : t('filesView.state.loading')}
        </div>
      ) : null}
    </div>
  );
};
