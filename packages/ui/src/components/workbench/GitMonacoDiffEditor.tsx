import React from 'react';

import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import type { DocumentIdentity } from '@/lib/documents/types';
import { useI18n } from '@/lib/i18n';
import { monacoDiffContentRevision } from '@/lib/monaco/diff-model-registry';
import { repositoryPathForGitDiff } from '@/lib/monaco/git-diff-resource';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import type { EditorViewState } from '@/lib/workbench/editors/types';
import { MonacoFileDiffEditor } from './MonacoFileDiffEditor';

type GitMonacoDiffEditorProps = {
  identity: DocumentIdentity;
  onViewStateChange?(viewState: EditorViewState): void;
  path: string;
  providerId: string;
  repositoryResourceId: string;
  scope: 'working' | 'staged';
  viewId: string;
  viewState: EditorViewState;
  workspaceRoot: string;
};

type GitDiffSnapshot =
  | { status: 'loading' }
  | { status: 'binary' }
  | { status: 'failure'; message: string }
  | { status: 'ready'; original: string; modified: string };

export const GitMonacoDiffEditor: React.FC<GitMonacoDiffEditorProps> = ({
  identity,
  onViewStateChange,
  path,
  providerId,
  repositoryResourceId,
  scope,
  viewId,
  viewState,
  workspaceRoot,
}) => {
  const { t } = useI18n();
  const git = useRuntimeAPIs().git;
  const [snapshot, setSnapshot] = React.useState<GitDiffSnapshot>({ status: 'loading' });
  const [retry, setRetry] = React.useState(0);

  React.useEffect(() => {
    const repositoryPath = repositoryPathForGitDiff(identity.resourceId, repositoryResourceId);
    if (repositoryPath === null || !repositoryPath) {
      setSnapshot({ status: 'failure', message: t('filesView.error.previewUnavailable') });
      return undefined;
    }
    const repositoryRoot = workspacePathFromResourceId(workspaceRoot, repositoryResourceId);
    const runtimeKey = getRuntimeKey();
    let cancelled = false;
    setSnapshot({ status: 'loading' });
    void git.getGitFileDiff(repositoryRoot, {
      path: repositoryPath,
      ...(scope === 'staged' ? { staged: true } : {}),
    }).then((result) => {
      if (cancelled || getRuntimeKey() !== runtimeKey) return;
      if (result.isBinary) {
        setSnapshot({ status: 'binary' });
        return;
      }
      setSnapshot({ status: 'ready', original: result.original ?? '', modified: result.modified ?? '' });
    }).catch((error) => {
      if (cancelled || getRuntimeKey() !== runtimeKey) return;
      setSnapshot({ status: 'failure', message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [git, identity.resourceId, repositoryResourceId, retry, scope, t, workspaceRoot]);

  if (snapshot.status === 'loading') {
    return <div className="flex h-full items-center justify-center typography-ui text-muted-foreground">{t('filesView.state.loading')}</div>;
  }
  if (snapshot.status === 'failure') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center typography-ui text-status-error">
        <span>{snapshot.message}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
          {t('startup.initRecovery.retry')}
        </Button>
      </div>
    );
  }
  if (snapshot.status === 'binary') {
    return <div className="flex h-full items-center justify-center p-4 typography-ui text-muted-foreground">{t('filesView.editor.cannotPreviewBinary')}</div>;
  }

  const originalRevision = `git:${scope}:original:${monacoDiffContentRevision(snapshot.original)}`;
  const modifiedRevision = `git:${scope}:modified:${monacoDiffContentRevision(snapshot.modified)}`;
  return (
    <MonacoFileDiffEditor
      identity={identity}
      originalContent={snapshot.original}
      originalRevision={originalRevision}
      {...(scope === 'staged'
        ? { modifiedContent: snapshot.modified, modifiedRevision }
        : {})}
      path={path}
      providerId={providerId}
      readOnly={scope === 'staged'}
      viewId={viewId}
      viewState={viewState}
      {...(onViewStateChange ? { onViewStateChange } : {})}
    />
  );
};
