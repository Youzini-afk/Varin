import { scopedProjectGit } from '@/lib/worktrees/projectGit';
import { runtimeFetch } from '@varin/application-client';

export type IntegratePlan = {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  commits: string[];
};

export type IntegrateConflictDetails = {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  currentPatchMeta: string;
  currentPatch: string;
};

export type IntegrateInProgress = {
  repoRoot: string;
  tempWorktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  /** Worktrees on target branch that were clean pre-integration; safe to fast-sync after ref update. */
  cleanTargetWorktrees: string[];
  remainingCommits: string[];
  currentCommit: string;
};

export type IntegrateResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'success'; moved: number }
  | { kind: 'conflict'; state: IntegrateInProgress; details: IntegrateConflictDetails };

const postIntegrate = async <T>(action: string, body: unknown): Promise<T> => {
  const response = await runtimeFetch(`/api/git/integrate/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Git integrate request failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
};

export async function computeIntegratePlan(args: {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<IntegratePlan> {
  const project = scopedProjectGit(args.repoRoot);
  if (project) return project.computeIntegratePlan(args);
  return postIntegrate<IntegratePlan>('plan', args);
}

export async function getIntegrateConflictDetails(tmpDir: string): Promise<IntegrateConflictDetails> {
  const project = scopedProjectGit(tmpDir);
  if (project) return project.getIntegrateConflictDetails(tmpDir);
  return postIntegrate<IntegrateConflictDetails>('conflict-details', { tempWorktreePath: tmpDir });
}

export async function isCherryPickInProgress(tmpDir: string): Promise<boolean> {
  const project = scopedProjectGit(tmpDir);
  if (project) return project.isCherryPickInProgress(tmpDir);
  const result = await postIntegrate<{ inProgress: boolean }>('cherry-pick-status', { tempWorktreePath: tmpDir });
  return result.inProgress;
}

export async function integrateWorktreeCommits(plan: IntegratePlan): Promise<IntegrateResult> {
  const project = scopedProjectGit(plan.repoRoot);
  if (project) return project.integrateWorktreeCommits(plan);
  return postIntegrate<IntegrateResult>('run', { plan });
}

export async function abortIntegrate(state: IntegrateInProgress): Promise<void> {
  const project = scopedProjectGit(state.repoRoot);
  if (project) return project.abortIntegrate(state);
  await postIntegrate<{ success: boolean }>('abort', { state });
}

export async function continueIntegrate(state: IntegrateInProgress): Promise<IntegrateResult> {
  const project = scopedProjectGit(state.repoRoot);
  if (project) return project.continueIntegrate(state);
  return postIntegrate<IntegrateResult>('continue', { state });
}
