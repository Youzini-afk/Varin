import React from 'react';
import { createResourceFilesHttpAPI, type FileSearchResult, type WorkspaceContentSearchHit } from '@varin/application-client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useProjectFileLocation } from '@/hooks/useProjectFileLocation';
import { openProjectResourceFile, resolveProjectEditorWorkspace } from '@/lib/workbench/editors/resource-workspace';
import { assertFileEnumeration, projectAbsolutePath, projectRelativePath } from '@/lib/projectFileOperations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { openWorkbenchEditor } from '@/lib/workbench/editors/session';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { requestFileEditorNavigation } from '@/lib/monaco/editor-command-service';
import type { IdeSearchMode } from '@/lib/workbench/ide-search-events';

type FileSearchViewState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'empty' }
  | { status: 'ready'; hits: FileSearchResult[]; incomplete?: boolean }
  | { status: 'failure'; message: string };

type ContentSearchViewState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'empty' }
  | { status: 'ready'; hits: WorkspaceContentSearchHit[]; incomplete?: boolean }
  | { status: 'failure'; message: string };

const IdeSearchResults: React.FC<{
  mode: IdeSearchMode;
  fileHits: FileSearchResult[];
  contentHits: WorkspaceContentSearchHit[];
  onOpenFile: (path: string) => void;
  onOpenContent: (hit: WorkspaceContentSearchHit) => void;
}> = ({ mode, fileHits, contentHits, onOpenFile, onOpenContent }) => {
  const parentRef = React.useRef<HTMLDivElement | null>(null);
  const count = mode === 'files' ? fileHits.length : contentHits.length;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => mode === 'files' ? 36 : 52,
    overscan: 8,
  });
  return (
    <div ref={parentRef} className="h-full overflow-auto p-2">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const fileHit = mode === 'files' ? fileHits[row.index] : undefined;
          const contentHit = mode === 'content' ? contentHits[row.index] : undefined;
          return (
            <div
              key={fileHit?.path ?? (contentHit ? `${contentHit.resource.resourceId}:${contentHit.line}:${contentHit.column}` : row.key)}
              className="absolute left-0 top-0 w-full"
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              {fileHit ? (
                <Button type="button" variant="ghost" size="sm" className="h-9 w-full justify-start truncate text-left" onClick={() => onOpenFile(fileHit.path)}>
                  {fileHit.path}
                </Button>
              ) : contentHit ? (
                <Button type="button" variant="ghost" size="sm" className="h-[52px] w-full justify-start text-left" onClick={() => onOpenContent(contentHit)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{contentHit.resource.resourceId}:{contentHit.line}</span>
                    <span className="truncate text-muted-foreground">{contentHit.preview}</span>
                  </span>
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const IdeSearchPanel: React.FC<{
  directory: string | undefined;
  focusRequestId: number;
  mode: IdeSearchMode;
  query: string;
  onModeChange(mode: IdeSearchMode): void;
  onQueryChange(query: string): void;
}> = ({ directory: navigationDirectory, focusRequestId, mode, query, onModeChange, onQueryChange }) => {
  const fileContext = useProjectFileLocation();
  const directory = fileContext.remote ? fileContext.location?.root : navigationDirectory;
  const resourceFiles = React.useMemo(createResourceFilesHttpAPI, []);
  const { t } = useI18n();
  const files = useRuntimeAPIs().files;
  const workspaceSearch = useRuntimeAPIs().workspaceSearch;
  const workspaceId = useWorkbenchWorkspaceId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileState, setFileState] = React.useState<FileSearchViewState>({ status: 'idle' });
  const [contentState, setContentState] = React.useState<ContentSearchViewState>({ status: 'idle' });

  React.useEffect(() => {
    if (focusRequestId <= 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequestId]);

  React.useEffect(() => {
    const normalized = query.trim();
    if (mode !== 'files') return undefined;
    if (!directory || !normalized) {
      setFileState({ status: 'idle' });
      return undefined;
    }
    setFileState({ status: 'searching' });
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      const location = fileContext.location;
      const request = location ? resourceFiles.request({ ...location, command: { kind: 'filename-search', path: '', query: normalized } }, controller.signal).then(result => {
        if (result.kind !== 'filename-search') throw new Error('Source search response is unavailable');
        assertFileEnumeration(result.enumerationStatus);
        return { hits: result.results.map(hit => ({ ...hit, path: projectAbsolutePath(location, hit.path) })), incomplete: result.enumerationStatus === 'incomplete' };
      }) : files.search({ directory, query: normalized }, { signal: controller.signal }).then(hits => ({ hits, incomplete: false }));
      void request.then(({ hits, incomplete }) => {
          if (cancelled || controller.signal.aborted) return;
          setFileState(hits.length === 0 && !incomplete ? { status: 'empty' } : { status: 'ready', hits, incomplete });
        })
        .catch((error) => {
          if (cancelled) return;
          if (error instanceof Error && error.name === 'AbortError') { setFileState({ status: 'idle' }); return; }
          setFileState({
            status: 'failure',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [directory, files, mode, query, fileContext.location, resourceFiles]);

  React.useEffect(() => {
    const normalized = query.trim();
    if (mode !== 'content') return undefined;
    if (!directory || !workspaceId || !normalized) {
      setContentState({ status: 'idle' });
      return undefined;
    }
    setContentState({ status: 'searching' });
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      const searchRequest = fileContext.location ? resourceFiles.request({ ...fileContext.location, command: { kind: 'content-search', path: '', query: normalized } }, controller.signal).then(result => { if (result.kind !== 'content-search') throw new Error('Source content search is unavailable'); return result.result; }) : workspaceSearch.searchContent(
        { workspaceId, query: normalized },
        {
          signal: controller.signal,
          onBatch: (hits) => {
            if (cancelled || hits.length === 0) return;
            setContentState((current) => ({
              status: 'ready',
              hits: current.status === 'ready' ? [...current.hits, ...hits] : [...hits],
            }));
          },
        },
      );
      void searchRequest.then((result) => {
        if (cancelled) return;
        if (result.status === 'cancelled') { setContentState({ status: 'idle' }); return; }
        if (result.status === 'failure') {
          setContentState({ status: 'failure', message: result.message });
          return;
        }
        if (result.status === 'empty') {
          setContentState({ status: 'empty' });
          return;
        }
        if (result.status !== 'ready') return;
        setContentState({ status: 'ready', hits: result.hits, incomplete: 'incomplete' in result && Boolean(result.incomplete) });
      }).catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setContentState({
          status: 'failure',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [directory, mode, query, workspaceId, workspaceSearch, fileContext.location, resourceFiles]);

  const openFileHit = (path: string) => {
    if (!directory || !workspaceId) return;
    if (fileContext.location) { openProjectResourceFile(fileContext.location, projectRelativePath(fileContext.location, path), { target: 'editor' }); return; }
    const resourceId = resourceIdFromWorkspacePath(directory, path);
    if (resourceId) openWorkbenchEditor(workspaceId, resourceId);
  };

  const openContentHit = (hit: WorkspaceContentSearchHit) => {
    if (!directory || !workspaceId) return;
    const opened = fileContext.location ? openProjectResourceFile(fileContext.location, hit.resource.resourceId, { target: 'editor' }) : openWorkbenchEditor(workspaceId, hit.resource.resourceId);
    requestFileEditorNavigation(
      fileContext.location ? { workspaceId: resolveProjectEditorWorkspace(fileContext.location).documentWorkspaceId, resourceId: hit.resource.resourceId } : hit.resource,
      hit.line,
      hit.column,
      activeEditorTab(opened)?.viewId,
    );
  };

  const activeState = mode === 'files' ? fileState : contentState;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 p-2">
        <div className="flex gap-1">
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={mode === 'files'}
            onClick={() => onModeChange('files')}
          >
            {t('workbench.ide.search.filesTab')}
          </Button>
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={mode === 'content'}
            onClick={() => onModeChange('content')}
          >
            {t('workbench.ide.search.contentTab')}
          </Button>
        </div>
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t(mode === 'files' ? 'workbench.ide.search.placeholder' : 'workbench.ide.search.contentPlaceholder')}
          aria-label={t(mode === 'files' ? 'workbench.ide.search.filesAria' : 'workbench.ide.search.contentAria')}
        />
      </div>
      {fileContext.error && <p role="alert">{fileContext.error}<Button variant="ghost" size="sm" onClick={fileContext.retry}>{t('common.retry')}</Button></p>}
      {activeState.status === 'ready' && activeState.incomplete && <p role="status" className="p-2 typography-meta text-muted-foreground">{t('files.search.incomplete')}</p>}
      <div className="min-h-0 flex-1 overflow-hidden typography-ui">
        {!directory || (mode === 'content' && !workspaceId) ? (
          <p className="p-2 text-muted-foreground">
            {t(mode === 'files' ? 'workbench.ide.search.noWorkspace' : 'workbench.ide.search.contentNoWorkspace')}
          </p>
        ) : activeState.status === 'searching' ? (
          <p className="p-2 text-muted-foreground">{t('workbench.ide.search.searching')}</p>
        ) : activeState.status === 'failure' ? (
          <p className="p-2 text-[color:var(--status-error)]">
            {t(mode === 'files' ? 'workbench.ide.search.failed' : 'workbench.ide.search.contentFailed', { message: activeState.message })}
          </p>
        ) : activeState.status === 'empty' ? (
          <p className="p-2 text-muted-foreground">
            {t(mode === 'files' ? 'workbench.ide.search.empty' : 'workbench.ide.search.contentEmpty')}
          </p>
        ) : (fileState.status === 'ready' && mode === 'files') || (contentState.status === 'ready' && mode === 'content') ? (
          <IdeSearchResults
            mode={mode}
            fileHits={fileState.status === 'ready' ? fileState.hits : []}
            contentHits={contentState.status === 'ready' ? contentState.hits : []}
            onOpenFile={openFileHit}
            onOpenContent={openContentHit}
          />
        ) : null}
      </div>
    </div>
  );
};

