import React from 'react';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { SurfaceContribution } from '@varin/extension-surface';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { DocumentCodeMirror } from '@/components/ui/DocumentCodeMirror';
import { DocumentMonacoEditor } from '@/components/workbench/DocumentMonacoEditor';
import { MonacoFileDiffEditor } from '@/components/workbench/MonacoFileDiffEditor';
import { GitMonacoDiffEditor } from '@/components/workbench/GitMonacoDiffEditor';
import {
  executeFileEditorCommand,
  FILE_EDITOR_COMMAND_IDS,
  saveFileEditorDocument,
} from '@/lib/monaco/editor-command-service';
import { DocumentConflictBanner } from '@/components/workbench/DocumentConflictBanner';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { MarkdownResourcePreview } from './MarkdownResourcePreview';
import { DiagramEditor } from '@/components/diagram';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { getRuntimeUrlResolver } from '@varin/application-client';
import { isDrawioFile, isImageFile, isPdfFile, isSvgFile } from '@/lib/toolHelpers';
import { useI18n } from '@/lib/i18n';
import { BUILTIN_EDITOR_PROVIDER_IDS } from '@/lib/workbench/editors/types';
import type { EditorTab, EditorViewState } from '@/lib/workbench/editors/types';
import {
  getEditorProvidersRevision,
  isEditorProviderEnabled,
  selectEditorProvider,
  setUserEditorAssociation,
  subscribeEditorProviders,
} from '@/lib/workbench/editors/providers';
import { patchEditorViewState, pinWorkbenchEditor, setEditorPreviewMode } from '@/lib/workbench/editors/session';
import { applyEditorViewState, captureEditorViewState } from '@/lib/workbench/editors/view-state';
import {
  activatePiEditorContextOwner,
  publishPiEditorContext,
  releasePiEditorContextOwner,
} from '@/stores/usePiEditorContextStore';
import type { DocumentIdentity } from '@/lib/documents/types';
import { useUIStore } from '@/stores/useUIStore';
import { getModifierLabel } from '@/lib/utils';
import {
  WorkbenchSurfaceContributionHost,
  useSurfaceRegistrySnapshot,
} from '@/lib/extensions/workbench-registry';
import { listEditorProviders } from '@/lib/workbench/editors/providers';
import { useDeviceInfo } from '@/lib/device';
import { getRuntimeKey } from '@varin/application-client';
import { createEditorDocumentController } from '@/lib/extensions/editor-document-controller';
import { WorkbenchPdfReader } from './WorkbenchPdfReader';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { usePiDraftStore } from '@/stores/usePiDraftStore';
import { BrowserResourceView } from './BrowserResourceView';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { MaterialViewActions } from './MaterialViewActions';
import { DiffLayoutControl } from './DiffLayoutControl';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

type ResourceEditorHostProps = {
  excludedProviderIds?: readonly string[];
  onViewStateChange?(viewState: EditorViewState): void;
  workspaceId: string;
  workspaceRoot: string;
  tab: EditorTab;
};

const stringArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
);
const EMPTY_PROVIDER_IDS: readonly string[] = [];

const TEXT_PROVIDERS = new Set<string>([
  BUILTIN_EDITOR_PROVIDER_IDS.text,
  BUILTIN_EDITOR_PROVIDER_IDS.markdown,
  BUILTIN_EDITOR_PROVIDER_IDS.json,
  BUILTIN_EDITOR_PROVIDER_IDS.html,
  BUILTIN_EDITOR_PROVIDER_IDS.drawio,
  BUILTIN_EDITOR_PROVIDER_IDS.diff,
]);

const HostFrame: React.FC<{
  chooser: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}> = ({ chooser, toolbar, children }) => (
  <div className="workbench-material-frame flex h-full min-h-0 flex-col">
    {chooser}
    {toolbar}
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>
);

export const ResourceEditorHost: React.FC<ResourceEditorHostProps> = ({
  excludedProviderIds = EMPTY_PROVIDER_IDS,
  onViewStateChange,
  workspaceId,
  workspaceRoot,
  tab,
}) => {
  const { t } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const currentSessionWorkspaceId = usePiSessionStore((state) => {
    if (!state.currentSessionId) return null;
    const workspace = state.records[state.currentSessionId]?.snapshot?.workspace;
    return workspace?.kind === 'workspace' ? workspace.id : null;
  });
  const path = workspacePathFromResourceId(workspaceRoot, tab.resourceId);
  const displayPath = tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? tab.viewState.browserUrl ?? t('contextPanel.mode.browser') : tab.resourceId;
  const identity = React.useMemo<DocumentIdentity>(
    () => ({ workspaceId, resourceId: tab.resourceId }),
    [tab.resourceId, workspaceId],
  );
  const surfaceSnapshot = useSurfaceRegistrySnapshot();
  const surfaceContributions = React.useMemo(() => surfaceSnapshot.visibleContributions.filter((contribution) => (
    contribution.descriptor.kind === 'editor'
    && !excludedProviderIds.includes(contribution.descriptor.id)
  )), [excludedProviderIds, surfaceSnapshot.visibleContributions]);
  const surfaceProviders = React.useMemo(() => surfaceContributions.map((contribution) => ({
    id: contribution.descriptor.id,
    extensionId: contribution.owner.extensionId,
    enabled: true,
    languages: stringArray(contribution.descriptor.data.languageIds),
    filenames: stringArray(contribution.descriptor.data.filenames),
    priority: typeof contribution.descriptor.data.priority === 'number'
      && Number.isFinite(contribution.descriptor.data.priority)
      ? contribution.descriptor.data.priority
      : 50,
  })), [surfaceContributions]);
  const surfaceContributionById = React.useMemo(() => new Map<string, SurfaceContribution>(
    surfaceContributions.map((contribution) => [contribution.descriptor.id, contribution]),
  ), [surfaceContributions]);
  React.useSyncExternalStore(subscribeEditorProviders, getEditorProvidersRevision, () => 0);
  const selection = selectEditorProvider(tab.resourceId, [...listEditorProviders(), ...surfaceProviders]);
  // A pinned provider was chosen explicitly for this tab, so resolution must not replace it. It
  // still yields to the provider being disabled, which is an authoritative unavailable state.
  const pinnedProviderId = tab.providerPinned === true && isEditorProviderEnabled(tab.providerId)
    ? tab.providerId
    : undefined;
  const activeProviderId = pinnedProviderId
    ?? (selection.status === 'selected'
      ? selection.providerId
      : (isEditorProviderEnabled(tab.providerId) ? tab.providerId : BUILTIN_EDITOR_PROVIDER_IDS.text));
  const surfaceContribution = surfaceContributionById.get(activeProviderId);
  const needsText = TEXT_PROVIDERS.has(activeProviderId) && isEditorProviderEnabled(activeProviderId);
  const needsGitWorkingDocument = activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.gitDiff
    && (tab.viewState.diffScope ?? 'working') === 'working';
  const needsDocument = needsText || needsGitWorkingDocument || Boolean(surfaceContribution);
  const record = useDocumentRecord(needsDocument ? identity : undefined);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState('');
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);
  const expandedEditorToolbar = useUIStore((state) => state.expandedEditorToolbar);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const editorContextOwnerId = `view:${tab.viewId}`;
  const codeMirrorViewRef = React.useRef<EditorView | null>(null);

  React.useEffect(() => {
    if (!needsDocument) return;
    void getDocumentRegistry().open(identity).catch(() => undefined);
  }, [identity, needsDocument]);

  const editorDocument = React.useMemo(() => createEditorDocumentController({
    identity,
    origin: `editor:${activeProviderId}`,
  }), [activeProviderId, identity]);
  const editorMountProps = React.useMemo(() => ({
    document: editorDocument,
    providerId: activeProviderId,
    resource: identity,
    viewId: tab.viewId,
  }), [activeProviderId, editorDocument, identity, tab.viewId]);
  const isolatedEditorProps = React.useMemo(() => ({
    providerId: activeProviderId,
    resource: identity,
    viewId: tab.viewId,
  }), [activeProviderId, identity, tab.viewId]);

  React.useEffect(() => {
    if (record?.dirty && tab.preview) pinWorkbenchEditor(workspaceId, tab.tabId);
  }, [record?.dirty, tab.preview, tab.tabId, workspaceId]);

  React.useEffect(() => {
    if (!autoSaveEnabled || !record?.dirty || record.saving || record.status !== 'ready') return;
    const timer = setTimeout(() => {
      void saveFileEditorDocument(identity).catch((error) => {
        console.error('[Editor] Auto-save failed:', error);
      });
    }, 1_500);
    return () => clearTimeout(timer);
  }, [autoSaveEnabled, identity, record?.dirty, record?.localEditRevision, record?.saving, record?.status]);

  React.useEffect(() => {
    if (activeProviderId !== BUILTIN_EDITOR_PROVIDER_IDS.image || isSvgFile(path) || !runtime.isDesktop) {
      return;
    }
    let cancelled = false;
    const readBinary = files.readFileBinary;
    if (!readBinary) return;
    void readBinary(path).then((result) => {
      if (!cancelled) setDesktopImageSrc(result.dataUrl);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeProviderId, files, path, runtime.isDesktop]);

  const publishCodeMirrorContext = React.useCallback((view: EditorView): void => {
    const open = getDocumentRegistry().get(identity);
    if (!open?.documentInstanceId) return;
    const range = view.state.selection.main;
    const hasText = range.from !== range.to;
    const fromLine = view.state.doc.lineAt(range.from);
    const toLine = view.state.doc.lineAt(range.to);
    publishPiEditorContext(editorContextOwnerId, {
      documentInstanceId: open.documentInstanceId,
      fileName: tab.resourceId.split('/').pop() || tab.resourceId,
      filePath: path,
      fileSize: open.byteLength,
      relativePath: tab.resourceId,
      runtimeKey: getRuntimeKey(),
      selection: hasText
        ? {
            startLine: fromLine.number,
            startColumn: range.from - fromLine.from + 1,
            endLine: toLine.number,
            endColumn: range.to - toLine.from + 1,
            text: view.state.sliceDoc(range.from, range.to),
          }
        : null,
      dirty: open.dirty,
      viewId: tab.viewId,
      workspaceId,
    });
  }, [editorContextOwnerId, identity, path, tab.resourceId, tab.viewId, workspaceId]);

  const viewStateExtension = React.useMemo<Extension>(() => ([
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.viewportChanged) return;
      const viewState = captureEditorViewState(update.view);
      if (onViewStateChange) onViewStateChange(viewState);
      else patchEditorViewState(workspaceId, tab.viewId, viewState);
      if (update.selectionSet) publishCodeMirrorContext(update.view);
    }),
    EditorView.domEventHandlers({
      focus: (_event, view) => {
        activatePiEditorContextOwner(editorContextOwnerId);
        publishCodeMirrorContext(view);
        return false;
      },
    }),
  ]), [editorContextOwnerId, onViewStateChange, publishCodeMirrorContext, tab.viewId, workspaceId]);

  React.useEffect(() => {
    if (!codeMirrorViewRef.current) return;
    publishCodeMirrorContext(codeMirrorViewRef.current);
  }, [publishCodeMirrorContext, record?.byteLength, record?.dirty, record?.documentInstanceId, record?.localEditRevision]);

  if (selection.status === 'none' && !isEditorProviderEnabled(BUILTIN_EDITOR_PROVIDER_IDS.text)) {
    return (
      <div className="flex h-full items-center justify-center p-4 typography-ui text-muted-foreground">
        {t('filesView.editor.providerUnavailable')}
      </div>
    );
  }

  const ambiguousChooser = selection.status === 'ambiguous' ? (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
      <span className="typography-meta text-muted-foreground">{t('filesView.editor.providerAmbiguous')}</span>
      {selection.providerIds.map((providerId) => (
        <Button
          key={providerId}
          variant="outline"
          size="xs"
          onClick={() => setUserEditorAssociation(tab.resourceId, providerId)}
        >
          {t('filesView.editor.useProvider', { provider: providerId })}
        </Button>
      ))}
    </div>
  ) : null;

  const setMode = (previewMode: 'preview' | 'edit' | 'tree' | 'text'): void => {
    if (onViewStateChange) onViewStateChange({ previewMode });
    else setEditorPreviewMode(workspaceId, tab.viewId, previewMode);
  };
  const setDiffScope = (diffScope: 'working' | 'staged'): void => {
    if (onViewStateChange) onViewStateChange({ diffScope });
    else patchEditorViewState(workspaceId, tab.viewId, { diffScope });
  };
  const modeToggle = (() => {
    if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.json) {
      const tree = tab.viewState.previewMode !== 'text';
      return (
        <Button type="button" variant="ghost" size="xs" onClick={() => setMode(tree ? 'text' : 'tree')}>
          {t(tree ? 'filesView.editor.switchToTextView' : 'filesView.editor.switchToTreeView')}
        </Button>
      );
    }
    if (
      activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.markdown
      || activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.html
      || activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.drawio
    ) {
      const preview = tab.viewState.previewMode !== 'edit';
      return (
        <Button type="button" variant="ghost" size="xs" onClick={() => setMode(preview ? 'edit' : 'preview')}>
          {t(preview ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
        </Button>
      );
    }
    return null;
  })();
  const editorActions = activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.gitDiff ? (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-pressed={(tab.viewState.diffScope ?? 'working') === 'working'}
        onClick={() => setDiffScope('working')}
      >
        {t('diffView.scope.changed')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-pressed={tab.viewState.diffScope === 'staged'}
        onClick={() => setDiffScope('staged')}
      >
        {t('diffView.scope.staged')}
      </Button>
      {(tab.viewState.diffScope ?? 'working') === 'working' && (record?.dirty || record?.saving) ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto size-7 p-0"
          disabled={!record?.dirty || record.saving}
          title={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
          aria-label={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
          onClick={() => {
            void saveFileEditorDocument(identity).catch((error) => {
              toast.error(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          <Icon name={record?.saving ? 'loader-4' : 'save-3'} className={record?.saving ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      ) : null}
    </div>
  ) : needsText ? (
    <div className="flex shrink-0 items-center gap-1">
      {modeToggle}
      {expandedEditorToolbar && !isMobile ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="size-7 p-0"
            title={t('filesView.editor.findInFile')}
            aria-label={t('filesView.editor.findInFile')}
            onClick={() => void executeFileEditorCommand(identity, FILE_EDITOR_COMMAND_IDS.find, tab.viewId)}
          >
            <Icon name="search" className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="size-7 p-0"
            title={t('filesView.editor.goToLine')}
            aria-label={t('filesView.editor.goToLine')}
            onClick={() => void executeFileEditorCommand(identity, FILE_EDITOR_COMMAND_IDS.goToLine, tab.viewId)}
          >
            <Icon name="file-text" className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="size-7 p-0"
            title={t('commandPalette.item.toggleEditorWrap')}
            aria-label={t('commandPalette.item.toggleEditorWrap')}
            onClick={() => void executeFileEditorCommand(identity, FILE_EDITOR_COMMAND_IDS.toggleWrap, tab.viewId)}
          >
            <Icon name="text-wrap" className="size-4" />
          </Button>
        </>
      ) : null}
      {record?.dirty || record?.saving ? <Button
        type="button"
        variant="ghost"
        size="xs"
        className="ml-auto size-7 p-0"
        disabled={!record?.dirty || record.saving}
        title={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
        aria-label={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
        onClick={() => {
          void saveFileEditorDocument(identity).catch((error) => {
            toast.error(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        <Icon name={record?.saving ? 'loader-4' : 'save-3'} className={record?.saving ? 'size-4 animate-spin' : 'size-4'} />
      </Button> : null}
    </div>
  ) : null;

  const toolbar = <div className="workbench-editor-location flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-border/50 px-2">
    <nav aria-label={displayPath} title={displayPath} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden typography-micro text-muted-foreground">
      {tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? <><Icon name="global" className="size-3 shrink-0" /><span className="truncate">{displayPath}</span></> : <>
        <span className="min-w-0 truncate">{tab.resourceId.split('/').slice(0, -1).join(' / ')}</span>
        {tab.resourceId.includes('/') ? <Icon name="arrow-right-s" className="size-3 shrink-0" /> : null}
        <span className="min-w-0 truncate text-foreground/85">{tab.resourceId.split('/').at(-1)}</span>
      </>}
    </nav>
    {editorActions}
    {activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.diff || activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.gitDiff
      ? <DiffLayoutControl value={tab.viewState.diffLayout} onChange={diffLayout => {
        if (onViewStateChange) onViewStateChange({ diffLayout }); else patchEditorViewState(workspaceId, tab.viewId, { diffLayout }, { notify: true });
      }} /> : null}
    {needsText || activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? <button type="button" disabled={!currentSessionId} aria-label={t('chat.fileAttachment.activeEditor.addFile', { name: displayPath })} title={t('chat.fileAttachment.activeEditor.addFile', { name: displayPath })}
      onMouseDown={event => event.preventDefault()}
      className="workbench-icon-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40"
      onClick={() => {
        if (!currentSessionId) return;
        if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.browser) usePiDraftStore.getState().appendText(currentSessionId, tab.viewState.browserUrl ?? '');
        else {
          const result = attachEditorContext({ sessionId: currentSessionId, workspaceId, resourceId: tab.resourceId, kind: 'editor' });
          if ('status' in result) { toast.error(t(result.status === 'missing-document' ? 'workbench.attachment.missing-document' : 'workbench.attachment.wrong-runtime')); return; }
        }
        window.dispatchEvent(new Event('varin:ide-focus-agent'));
        requestAnimationFrame(focusChatInput);
      }}><Icon name="attachment-2" className="size-3.5" /></button> : null}
    <MaterialViewActions workspaceId={workspaceId} workspaceRoot={workspaceRoot} tab={tab} />
    {needsText ? <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><button type="button" aria-label={t('chat.piComposer.options')} title={t('chat.piComposer.options')}
        className="workbench-icon-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
        <Icon name="more" className="size-3.5" />
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!expandedEditorToolbar || isMobile ? <>
          <DropdownMenuItem onSelect={() => void executeFileEditorCommand(identity, FILE_EDITOR_COMMAND_IDS.find, tab.viewId)}>{t('filesView.editor.findInFile')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void executeFileEditorCommand(identity, FILE_EDITOR_COMMAND_IDS.goToLine, tab.viewId)}>{t('filesView.editor.goToLine')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void executeFileEditorCommand(identity, FILE_EDITOR_COMMAND_IDS.toggleWrap, tab.viewId)}>{t('commandPalette.item.toggleEditorWrap')}</DropdownMenuItem>
        </> : null}
        <DropdownMenuItem onSelect={() => setAutoSaveEnabled(!autoSaveEnabled)}>
          <span className="flex-1">{t('filesView.editor.autoSaveOn')}</span>{autoSaveEnabled ? <Icon name="check" className="size-3.5" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : null}
  </div>;

  if (needsDocument && (!record || record.status === 'loading' || record.status === 'unloaded')) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center typography-ui text-muted-foreground">
          {t('filesView.state.loading')}
        </div>
      </HostFrame>
    );
  }

  if (surfaceContribution) {
    const fallback = (
      <ResourceEditorHost
        excludedProviderIds={[...excludedProviderIds, activeProviderId]}
        workspaceId={workspaceId}
        workspaceRoot={workspaceRoot}
        tab={tab}
        {...(onViewStateChange ? { onViewStateChange } : {})}
      />
    );
    return (
      <WorkbenchSurfaceContributionHost
        className="h-full min-h-0 w-full min-w-0"
        contribution={surfaceContribution}
        fallback={fallback}
        isolatedProps={isolatedEditorProps}
        props={editorMountProps}
      />
    );
  }

  if (record?.status === 'binary' || record?.status === 'unsupported-encoding') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-4 text-center typography-ui text-muted-foreground">
          {record.status === 'binary'
            ? t('filesView.editor.binaryFileDescription')
            : t('filesView.error.previewUnavailable')}
        </div>
      </HostFrame>
    );
  }

  if (record?.status === 'error') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-4 text-center typography-ui text-status-error">
          {record.errorMessage ?? t('filesView.error.previewUnavailable')}
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.browser) {
    return <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
      <BrowserResourceView key={tab.viewId} initialUrl={tab.viewState.browserUrl ?? ''} directory={workspaceRoot}
        initialPosition={tab.viewState.browserPosition}
        tabID={tab.viewState.browserTabId ?? tab.viewId} onNavigate={browserUrl => patchEditorViewState(workspaceId, tab.viewId, { browserUrl }, { notify: true })} />
    </HostFrame>;
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.image) {
    const src = runtime.isDesktop && !isSvgFile(path)
      ? desktopImageSrc
      : getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, directory: workspaceRoot });
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-3">
          <img src={src} alt={tab.resourceId} className="max-h-full max-w-full object-contain rounded-md border border-border/30" />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.pdf || isPdfFile(path)) {
    const originalPdf = getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, directory: workspaceRoot });
    if (!currentSessionId || currentSessionWorkspaceId !== workspaceId) {
      return (
        <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
              {t('harness.pdf.sessionWorkspaceRequired')}
            </div>
            <iframe title={tab.resourceId} src={originalPdf} className="min-h-0 flex-1 border-0" />
          </div>
        </HostFrame>
      );
    }
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <WorkbenchPdfReader
          key={`${tab.viewId}:${currentSessionId}`}
          workspaceId={workspaceId}
          sessionId={currentSessionId}
          tab={tab}
          path={path}
          onOpenOriginal={() => {
            window.open(originalPdf, '_blank', 'noopener,noreferrer');
          }}
        />
      </HostFrame>
    );
  }

  const buffer = record?.buffer ?? '';

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.markdown && tab.viewState.previewMode !== 'edit') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <ErrorBoundary fallback={<div className="p-3 typography-ui text-status-error">{t('filesView.error.previewUnavailable')}</div>}>
          <MarkdownResourcePreview key={tab.viewId} workspaceId={workspaceId} tab={tab} content={buffer} />
        </ErrorBoundary>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.json && tab.viewState.previewMode !== 'text') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="h-full overflow-auto">
          <JsonTreeView jsonString={buffer} maxHeight="100%" initiallyExpandedDepth={2} />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.html && tab.viewState.previewMode !== 'edit') {
    const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    const src = getRuntimeUrlResolver().authenticatedAsset(`/api/fs/serve${encoded.startsWith('/') ? encoded : `/${encoded}`}`);
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <iframe title={tab.resourceId} src={src} className="h-full w-full border-none" sandbox="allow-scripts allow-same-origin allow-forms" />
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.drawio && isDrawioFile(path) && tab.viewState.previewMode !== 'edit') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="h-full overflow-hidden" style={{ minHeight: '400px' }}>
          <DiagramEditor
            xml={buffer}
            onChange={(xml) => getDocumentRegistry().applyTransaction(identity, xml, { origin: 'drawio' })}
          />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.gitDiff) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <GitMonacoDiffEditor
          identity={identity}
          path={path}
          providerId={activeProviderId}
          repositoryResourceId={tab.viewState.diffRepositoryResourceId ?? ''}
          scope={tab.viewState.diffScope ?? 'working'}
          viewId={tab.viewId}
          viewState={tab.viewState}
          workspaceRoot={workspaceRoot}
          {...(onViewStateChange ? { onViewStateChange } : {})}
        />
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.diff) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        {isMobile ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="border-b border-border/40 px-3 py-1.5 typography-meta text-muted-foreground">
              {t('filesView.editor.diffAgainstDisk')}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3 typography-meta whitespace-pre-wrap">
              {record?.baseContent ?? ''}
            </div>
          </div>
        ) : (
          <MonacoFileDiffEditor
            identity={identity}
            originalContent={record?.baseContent ?? ''}
            originalRevision={`document:${record?.baseRevision ?? 'missing'}`}
            path={path}
            providerId={activeProviderId}
            readOnly={false}
            viewId={tab.viewId}
            viewState={tab.viewState}
            {...(onViewStateChange ? { onViewStateChange } : {})}
          />
        )}
      </HostFrame>
    );
  }

  if (isImageFile(path) && activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.text) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-3 typography-ui text-muted-foreground">
          {t('filesView.editor.cannotPreviewBinary')}
        </div>
      </HostFrame>
    );
  }

  return (
    <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
      <div className="flex h-full min-h-0 flex-col">
        <DocumentConflictBanner identity={identity} />
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* Mobile owns the document-bound CodeMirror adapter. Desktop/Web use the
              shared Monaco model. */}
          {isMobile ? (
            <DocumentCodeMirror
              identity={identity}
              className="h-full"
              extensions={[viewStateExtension]}
              onViewReady={(view) => {
                codeMirrorViewRef.current = view;
                applyEditorViewState(view, tab.viewState);
                publishCodeMirrorContext(view);
              }}
              onViewDestroy={() => {
                codeMirrorViewRef.current = null;
                releasePiEditorContextOwner(editorContextOwnerId);
              }}
              vimMode={fileEditorKeymap === 'vim'}
            />
          ) : (
            <DocumentMonacoEditor
              identity={identity}
              path={path}
              providerId={activeProviderId}
              viewId={tab.viewId}
              viewState={tab.viewState}
              className="h-full"
              {...(onViewStateChange ? { onViewStateChange } : {})}
            />
          )}
        </div>
      </div>
    </HostFrame>
  );
};
