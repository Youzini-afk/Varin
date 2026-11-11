import type { SimpleGit } from 'simple-git';
import type { MutationOwner } from '../documents/authority.js';
import type { GitIdentityProfile } from './identity-storage.js';

export type GitClient = SimpleGit;
export interface ProcessWriter { close(): Promise<void>; markMutated(): Promise<void> }

export interface GitDocumentAuthority {
  registerWriterForScope(
    scope: unknown,
    owner: MutationOwner,
    options?: Record<string, unknown>,
  ): Promise<ProcessWriter | null>;
  resolveScopeId?(scope: unknown): Promise<string | null>;
}

export type GitIdentityInput = Pick<GitIdentityProfile, 'userEmail' | 'userName'>
  & Partial<Omit<GitIdentityProfile, 'userEmail' | 'userName'>>;

export interface GitCommandResult {
  exitCode: number;
  message?: string;
  stderr: string;
  stdout: string;
  success: boolean;
}

export interface WorktreePorcelainEntry {
  branch?: string;
  branchRef?: string;
  head?: string;
  worktree: string;
}

export type WorktreeBootstrapStatus = 'pending' | 'ready' | 'failed';
export type WorktreeBootstrapPhase = 'directory-created' | 'git-ready' | 'setup-ready';

export interface WorktreeBootstrapState {
  error: string | null;
  phase: WorktreeBootstrapPhase;
  status: WorktreeBootstrapStatus;
  updatedAt: number;
}

export interface GitRuntimeOptions {
  authorizeDirectory?(directory: string): Promise<void>;
  documents?: GitDocumentAuthority;
  writerOwner?: MutationOwner;
}

export interface IntegratePlan {
  commits: string[];
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface IntegrateState {
  cleanTargetWorktrees: string[];
  currentCommit: string;
  repoRoot: string;
  remainingCommits: string[];
  sourceBranch: string;
  targetBranch: string;
  tempWorktreePath: string;
}

export interface RepositoryGitContext {
  directoryGit: SimpleGit;
  directoryPath: string;
  git: SimpleGit;
  repoRoot: string;
}

export interface GitFileContext {
  absolutePath: string;
  isSymbolicLink: boolean;
  repoPath: string;
  repoRoot: string;
}

export type InputRecord = Record<string, unknown>;
