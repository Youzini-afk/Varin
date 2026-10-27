import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ProjectEntry } from '@varin/application-client';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import {
  getWorktreeSetupCommands,
  getWorktreeSetupWaitEnabled,
  type VarinProjectRef,
} from '@/lib/project-config';
import {
  checkVarinGitRepository,
  createVarinWorktree,
} from '@/lib/varinWorktrees';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { startThreadFromNavigation } from './threadNavigation';

export interface WorktreeThreadResult {
  branch: string;
  path: string;
  draftKey: string;
}

export interface WorktreeThreadRuntime {
  checkIsGitRepository(directory: string): Promise<boolean>;
  openDraft(target: { directory: string; projectId: string }): Promise<string>;
  createWorktree(project: VarinProjectRef, preferredName: string): Promise<WorktreeMetadata>;
  generateBranchName(): string;
  getActiveProject(): ProjectEntry | null;
  shouldWaitForBootstrap(project: VarinProjectRef): Promise<boolean>;
  waitForBootstrap(directory: string): Promise<void>;
}

const defaultRuntime: WorktreeThreadRuntime = {
  checkIsGitRepository: checkVarinGitRepository,
  openDraft: (target) => startThreadFromNavigation({ directory: target.directory }),
  createWorktree: async (project, preferredName) => {
    const host = getRuntimeEndpointGeneration();
    const setupCommands = await getWorktreeSetupCommands(project);
    if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed before worktree creation');
    return createVarinWorktree(project, {
      mode: 'new',
      preferredName,
      branchName: preferredName,
      returnAfterDirectoryCreated: true,
      setupCommands,
    });
  },
  generateBranchName,
  getActiveProject: () => useProjectsStore.getState().getActiveProject() ?? null,
  shouldWaitForBootstrap: getWorktreeSetupWaitEnabled,
  waitForBootstrap: waitForWorktreeBootstrap,
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const createWorktreeThreadWithRuntime = async (
  runtime: WorktreeThreadRuntime,
): Promise<WorktreeThreadResult> => {
  const host = getRuntimeEndpointGeneration();
  const assertHost = () => { if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed; the original worktree remains on its original Host'); };
  const activeProject = runtime.getActiveProject();
  if (!activeProject?.path) throw new Error('Select a project before creating a worktree conversation');
  const project: VarinProjectRef = { id: activeProject.id, path: activeProject.path };
  if (!await runtime.checkIsGitRepository(await projectExecutionPath(project))) throw new Error('Worktree conversations require a Git repository');
  assertHost();
  const preferredName = runtime.generateBranchName().trim();
  if (!preferredName) throw new Error('Could not generate a worktree branch name');
  const worktree = await runtime.createWorktree(project, preferredName);
  assertHost();
  const waitForBootstrap = await runtime.shouldWaitForBootstrap(project); assertHost();
  if (waitForBootstrap) await runtime.waitForBootstrap(worktree.path);
  assertHost();
  try {
    const draftKey = await runtime.openDraft({ directory: worktree.path, projectId: project.id });
    return { branch: worktree.branch || preferredName, path: worktree.path, draftKey };
  } catch (error) {
    // The worktree exists independently of its local conversation draft.
    throw new Error(`Could not open a conversation. Worktree retained at ${worktree.path}: ${errorMessage(error)}`, { cause: error });
  }
};

export const createWorktreeThread = async (): Promise<WorktreeThreadResult> => (
  createWorktreeThreadWithRuntime(defaultRuntime)
);
import { projectExecutionPath } from '@/lib/nativeWorkspace';
