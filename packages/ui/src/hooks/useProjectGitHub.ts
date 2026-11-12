import * as React from 'react';
import type { GitHubAPI, GitHubAuthStatus } from '@varin/application-client';
import { projectGitHubReads } from '@/lib/worktrees/projectDiscovery';
import { remoteWorktreeProject, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';

export function useProjectGitHub(project: ProjectRef | null, local: GitHubAPI | null | undefined, open: boolean) {
  const localStatus = useGitHubAuthStore(state => state.status);
  const localChecked = useGitHubAuthStore(state => state.hasChecked);
  const remote = Boolean(project && remoteWorktreeProject(project));
  const github = React.useMemo(() => projectGitHubReads(project, local), [project, local]);
  const [result, setResult] = React.useState<{ reader: typeof github; status?: GitHubAuthStatus; error?: string }>();
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(() => {
    if (!open || !remote || !github) return;
    let cancelled = false;
    void github.authStatus().then(status => { if (!cancelled) setResult({ reader: github, status }); }, error => {
      if (!cancelled) setResult({ reader: github, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [open, remote, github, refresh]);
  const current = result?.reader === github ? result : undefined;
  return { github, remote, status: remote ? current?.status : localStatus,
    checked: remote ? Boolean(current) : localChecked, error: remote ? current?.error : undefined,
    refresh: () => setRefresh(value => value + 1) };
}

/** Target credentials stay in a per-consumer snapshot, never the coordinator store. */
export function useScopedGitHubAuth(github: GitHubAPI | undefined, scoped: boolean) {
  const local = useGitHubAuthStore();
  const [snapshot, setSnapshot] = React.useState<{ api: typeof github; status: GitHubAuthStatus | null; isLoading: boolean; hasChecked: boolean }>();
  const current = snapshot?.api === github ? snapshot : undefined;
  const setStatus = React.useCallback((status: GitHubAuthStatus | null) => {
    setSnapshot({ api: github, status, isLoading: false, hasChecked: true });
  }, [github]);
  const refreshStatus = React.useCallback(async () => {
    if (!github) throw new Error('Original GitHub owner unavailable');
    setSnapshot(previous => ({ api: github, status: previous?.api === github ? previous.status : null, isLoading: true, hasChecked: false }));
    try { const status = await github.authStatus(); setStatus(status); return status; }
    catch (error) { setStatus({ connected: false, error: error instanceof Error ? error.message : String(error) } as GitHubAuthStatus); return null; }
  }, [github, setStatus]);
  return scoped ? { status: current?.status ?? null, isLoading: current?.isLoading ?? false, hasChecked: current?.hasChecked ?? false, setStatus, refreshStatus } : local;
}
