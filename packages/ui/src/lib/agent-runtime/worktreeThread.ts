import { getRuntimeEndpointGeneration, manageProject } from '@varin/application-client';
import type { ProjectEntry } from '@varin/application-client';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import {
  getWorktreeSetupCommands,
  getWorktreeSetupWaitEnabled,
  type VarinProjectRef,
} from '@/lib/project-config';
import {
  checkVarinGitRepository,
} from '@/lib/varinWorktrees';
import { waitForProjectWorktreeBootstrap, remoteWorktreeProject } from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { worktreeDraftSource } from '@/lib/worktrees/projectDiscovery';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { startThreadFromNavigation } from './threadNavigation';

export interface WorktreeThreadResult {
  branch: string;
  path: string;
  draftKey: string;
}

export interface WorktreeThreadRuntime {
  checkIsGitRepository(directory: string, project?: VarinProjectRef): Promise<boolean>;
  openDraft(target: { directory: string; projectId: string; source?: ProjectEntry['source'] }): Promise<string>;
  createWorktree(project: VarinProjectRef, preferredName: string): Promise<WorktreeMetadata>;
  generateBranchName(): string;
  getActiveProject(): ProjectEntry | null;
  shouldWaitForBootstrap(project: VarinProjectRef): Promise<boolean>;
  waitForBootstrap(directory: string, project?: VarinProjectRef): Promise<void>;
}

const defaultRuntime: WorktreeThreadRuntime = {
  checkIsGitRepository: async (directory, project) => {
    if (project && remoteWorktreeProject(project)) {
      await manageProject(project.id, 'git-root-context', {}, undefined, project.source);
      return true;
    }
    return checkVarinGitRepository(project ? await projectExecutionPath(project) : directory);
  },
  openDraft: async (target) => startThreadFromNavigation({ directory: target.directory, projectId: target.projectId, worktreeProject: true,
    sourceSelection: await worktreeDraftSource({ id: target.projectId, path: target.directory, source: target.source }, target.directory) }),
  createWorktree: async (project, preferredName) => {
    const host = getRuntimeEndpointGeneration();
    const setupCommands = await getWorktreeSetupCommands(project);
    if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed before worktree creation');
    return createWorktreeWithDefaults(project, {
      mode: 'new',
      branchName: preferredName,
      returnAfterDirectoryCreated: true,
      setupCommands,
    });
  },
  generateBranchName,
  getActiveProject: () => useProjectsStore.getState().getActiveProject() ?? null,
  shouldWaitForBootstrap: getWorktreeSetupWaitEnabled,
  waitForBootstrap: async (directory, project) => {
    if (!project) throw new Error('Project identity is required for worktree setup');
    await waitForProjectWorktreeBootstrap(project, directory);
  },
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const createWorktreeThreadWithRuntime = async (
  runtime: WorktreeThreadRuntime,
): Promise<WorktreeThreadResult> => {
  const host = getRuntimeEndpointGeneration();
  const activeProject = runtime.getActiveProject();
  if (!activeProject?.path) throw new Error('Select a project before creating a worktree conversation');
  const originalProject = JSON.stringify([activeProject.id, activeProject.path, activeProject.source]);
  const assertHost = () => {
    const current = runtime.getActiveProject();
    if (host !== getRuntimeEndpointGeneration() || !current || originalProject !== JSON.stringify([current.id, current.path, current.source])) {
      throw new Error('Project source or Application Host changed; the original worktree remains with its original owner');
    }
  };
  const project: VarinProjectRef = { id: activeProject.id, path: activeProject.path, source: activeProject.source };
  if (!await runtime.checkIsGitRepository(project.path, project)) throw new Error('Worktree conversations require a Git repository');
  assertHost();
  const preferredName = runtime.generateBranchName().trim();
  if (!preferredName) throw new Error('Could not generate a worktree branch name');
  const worktree = await runtime.createWorktree(project, preferredName);
  assertHost();
  const waitForBootstrap = await runtime.shouldWaitForBootstrap(project); assertHost();
  if (waitForBootstrap) await runtime.waitForBootstrap(worktree.path, project);
  assertHost();
  try {
    const draftKey = await runtime.openDraft({ directory: worktree.path, projectId: project.id, source: project.source });
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
