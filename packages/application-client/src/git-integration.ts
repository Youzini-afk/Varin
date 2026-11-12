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

