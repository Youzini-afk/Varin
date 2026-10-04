
import * as gitHttp from './gitApiHttp';
import { actionInstruction } from './actionInstructions';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { generateStructuredInPiSession } from '@/lib/piStructuredGeneration';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { findPiProjectForCwd } from '@/lib/pi-runtime/sessionNavigation';

export type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitBranchDetails,
  GitBranch,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitIdentityProfile,
  GitIdentityAuthType,
  GitIdentitySummary,
  GitLogEntry,
  GitLogResponse,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationError,
  GitWorktreeValidationResult,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  DiscoveredGitCredential,
  GitRemote,
  GitMergeResult,
  GitRebaseResult,
  MergeConflictDetails,
  CommitFileDiffResponse,
} from '@varin/application-client';

const getRuntimeGit = () => {
  return getRegisteredRuntimeAPIs()?.git ?? null;
};

const requestChatForceScrollBottom = (sessionId: string) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('varin:chat-force-scroll-bottom', {
    detail: { sessionId },
  }));
};

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkIsGitRepository(directory);
  return gitHttp.checkIsGitRepository(directory);
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<import('@varin/application-client').GitStatus> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitStatus(directory, options);
  return gitHttp.getGitStatus(directory, options);
}

export async function resolveGitPrimaryRoot(directory: string): Promise<string> {
  const result = await gitHttp.resolveGitPrimaryRoot(directory);
  return result.root;
}

export async function resolveGitTopLevel(directory: string): Promise<string> {
  const result = await gitHttp.resolveGitTopLevel(directory);
  return result.root;
}

export async function getGitCommitSummaries(
  directory: string,
  shas: string[]
): Promise<Array<{ sha: string; short: string; subject: string }>> {
  const result = await gitHttp.getGitCommitSummaries(directory, shas);
  return result.commits;
}

export async function getGitDiff(directory: string, options: import('@varin/application-client').GetGitDiffOptions): Promise<import('@varin/application-client').GitDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitDiff(directory, options);
  return gitHttp.getGitDiff(directory, options);
}

export async function getGitFileDiff(
  directory: string,
  options: import('@varin/application-client').GetGitFileDiffOptions
): Promise<import('@varin/application-client').GitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitFileDiff(directory, options);
  return gitHttp.getGitFileDiff(directory, options);
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options?: { scope?: 'all' | 'working' }
): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertGitFile(directory, filePath, options);
  return gitHttp.revertGitFile(directory, filePath, options);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitFile) return runtime.stageGitFile(directory, filePath);
  return gitHttp.stageGitFile(directory, filePath);
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitFiles) return runtime.stageGitFiles(directory, filePaths);
  return gitHttp.stageGitFiles(directory, filePaths);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitFile) return runtime.unstageGitFile(directory, filePath);
  return gitHttp.unstageGitFile(directory, filePath);
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitFiles) return runtime.unstageGitFiles(directory, filePaths);
  return gitHttp.unstageGitFiles(directory, filePaths);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitHunk) return runtime.stageGitHunk(directory, filePath, patch);
  return gitHttp.stageGitHunk(directory, filePath, patch);
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitHunk) return runtime.unstageGitHunk(directory, filePath, patch);
  return gitHttp.unstageGitHunk(directory, filePath, patch);
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.revertGitHunk) return runtime.revertGitHunk(directory, filePath, patch);
  return gitHttp.revertGitHunk(directory, filePath, patch);
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.isLinkedWorktree(directory);
  return gitHttp.isLinkedWorktree(directory);
}

export async function getGitBranches(directory: string): Promise<import('@varin/application-client').GitBranch> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitBranches(directory);
  return gitHttp.getGitBranches(directory);
}

export async function deleteGitBranch(directory: string, payload: import('@varin/application-client').GitDeleteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitBranch(directory, payload);
  return gitHttp.deleteGitBranch(directory, payload);
}

export async function deleteRemoteBranch(directory: string, payload: import('@varin/application-client').GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteRemoteBranch(directory, payload);
  return gitHttp.deleteRemoteBranch(directory, payload);
}

const parseCommitStructured = (structured: Record<string, unknown> | null): { subject: string; highlights: string[] } => {
  const subject = typeof structured?.subject === 'string' ? structured.subject.trim() : '';
  const highlights = Array.isArray(structured?.highlights)
    ? structured.highlights.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3)
    : [];
  if (!subject) {
    throw new Error('Structured output missing subject');
  }
  return { subject, highlights };
};

const COMMIT_GENERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string', description: 'Conventional commit subject line.' },
    highlights: {
      type: 'array',
      items: { type: 'string', description: 'Short user-facing highlight.' },
      maxItems: 3,
      description: 'Optional short user-facing highlights.',
    },
  },
  required: ['subject', 'highlights'],
};

const PR_GENERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Pull request title.' },
    body: { type: 'string', description: 'Pull request markdown description.' },
  },
  required: ['title', 'body'],
};

export async function generateCommitMessage(
  directory: string,
  files: string[],
  options?: { zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ message: import('@varin/application-client').GeneratedCommitMessage }> {
  const startedAt = Date.now();
  void options;

  console.info('[git-generation][browser] request', {
    transport: 'pi-session',
    kind: 'commit',
    directory,
    selectedFiles: files.length,
  });

  const visiblePrompt = await actionInstruction('git.commit.generate.visible');
  const hiddenPrompt = await actionInstruction('git.commit.generate.instructions', {
    selected_files: files.map((file) => `- ${file}`).join('\n'),
  });

  const generationSession = await resolveGenerationSessionContext(directory);

  try {
    const structured = await runStructuredGenerationInActiveSession({
      directory,
      visiblePrompt,
      hiddenPrompt,
      generationSession,
      schema: COMMIT_GENERATION_SCHEMA,
      kind: 'commit',
    });
    const result = { message: parseCommitStructured(structured) };
    console.info('[git-generation][browser] success', {
      transport: 'pi-session',
      kind: 'commit',
      elapsedMs: Date.now() - startedAt,
      subjectLength: result.message.subject.length,
      highlightsCount: result.message.highlights.length,
    });
    return result;
  } catch (error) {
    console.error('[git-generation][browser] failed', {
      transport: 'pi-session',
      kind: 'commit',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<import('@varin/application-client').GeneratedPullRequestDescription> {
  const startedAt = Date.now();

  const commitLog = await getGitLog(directory, {
    from: payload.base,
    to: payload.head,
    maxCount: 50,
  });
  const COMMIT_BODY_CHAR_LIMIT = 2_000;
  const commits = (Array.isArray(commitLog?.all) ? commitLog.all : [])
    .filter((entry) => typeof entry?.hash === 'string' && entry.hash.length > 0)
    .map((entry) => ({
      hash: entry.hash,
      subject: typeof entry.message === 'string' ? entry.message.trim() : '',
      body: typeof entry.body === 'string' ? entry.body.trim().slice(0, COMMIT_BODY_CHAR_LIMIT) : '',
    }));

  if (commits.length === 0) {
    throw new Error(`No commits found in range ${payload.base}...${payload.head}`);
  }

  const filesSet = new Set<string>();
  await Promise.all(commits.map(async (commit) => {
    try {
      const response = await getCommitFiles(directory, commit.hash);
      const files = Array.isArray(response?.files) ? response.files : [];
      for (const file of files) {
        if (typeof file?.path === 'string' && file.path.trim().length > 0) {
          filesSet.add(file.path.trim());
        }
      }
    } catch (error) {
      console.warn('[git-generation][browser] failed to collect commit files', {
        hash: commit.hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  const changedFiles = Array.from(filesSet).sort().slice(0, 300);

  console.info('[git-generation][browser] request', {
    transport: 'pi-session',
    kind: 'pr',
    directory,
    base: payload.base,
    head: payload.head,
    commits: commits.length,
    changedFiles: changedFiles.length,
  });

  const visiblePrompt = await actionInstruction('git.pr.generate.visible');
  const hiddenPrompt = await actionInstruction('git.pr.generate.instructions', {
    base_branch: payload.base,
    head_branch: payload.head,
    commits: commits.map((commit) => {
      const line = `- ${commit.hash.slice(0, 7)} ${commit.subject || '(no subject)'}`;
      if (!commit.body) return line;
      const indentedBody = commit.body.split('\n').map((bodyLine) => `  ${bodyLine}`).join('\n');
      return `${line}\n${indentedBody}`;
    }).join('\n'),
    changed_files: changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join('\n') : '- none detected',
    additional_context_block: payload.context?.trim() ? `\nAdditional context:\n${payload.context.trim()}` : '',
  });

  const parsePrStructured = (structured: Record<string, unknown> | null) => ({
    title: typeof structured?.title === 'string' ? structured.title.trim() : '',
    body: typeof structured?.body === 'string' ? structured.body.trim() : '',
  });

  const generationSession = await resolveGenerationSessionContext(directory);

  try {
    const structured = await runStructuredGenerationInActiveSession({
      directory,
      visiblePrompt,
      hiddenPrompt,
      generationSession,
      schema: PR_GENERATION_SCHEMA,
      kind: 'pr',
    });
    const result = parsePrStructured(structured);
    console.info('[git-generation][browser] success', {
      transport: 'pi-session',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      titleLength: result.title.length,
      bodyLength: result.body.length,
    });
    return result;
  } catch (error) {
    console.error('[git-generation][browser] failed', {
      transport: 'pi-session',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

type SessionGenerationContext = {
  sessionId: string;
  providerId: string;
  modelId: string;
  thinkingLevel: string;
};

const GENERATION_CONFIG_ERROR = 'No default provider or model configured. Please select a provider and model in settings first.';

async function resolveGenerationSessionContext(directory: string): Promise<SessionGenerationContext> {
  const sessions = usePiSessionStore.getState();
  let sessionId = sessions.currentSessionId;
  let snapshot = sessionId ? sessions.records[sessionId]?.snapshot : undefined;
  if (!sessionId || !snapshot) {
    const project = findPiProjectForCwd(useProjectsStore.getState().projects, directory);
    snapshot = await sessions.createSession(
      directory,
      'Git generation',
      undefined,
      project
        ? { id: project.id, kind: 'workspace' }
        : { kind: 'unbound' },
    );
    sessionId = snapshot.sessionId;
  }
  if (!snapshot.model) throw new Error(GENERATION_CONFIG_ERROR);
  return {
    sessionId,
    providerId: snapshot.model.provider,
    modelId: snapshot.model.id,
    thinkingLevel: snapshot.thinkingLevel,
  };
};

const runStructuredGenerationInActiveSession = async ({
  directory,
  visiblePrompt,
  hiddenPrompt,
  generationSession,
  schema,
  kind,
}: {
  directory: string;
  visiblePrompt: string;
  hiddenPrompt?: string;
  generationSession: SessionGenerationContext;
  schema: Record<string, unknown>;
  kind: 'commit' | 'pr';
}): Promise<Record<string, unknown>> => {
  const requestStartedAt = Date.now();
  console.info('[git-generation][browser] runStructuredGenerationInActiveSession start', {
    kind,
    directory,
    sessionId: generationSession.sessionId,
    providerId: generationSession.providerId,
    modelId: generationSession.modelId,
    thinkingLevel: generationSession.thinkingLevel,
  });
  const visiblePromptText = typeof visiblePrompt === 'string' ? visiblePrompt.trim() : '';
  const hiddenPromptText = typeof hiddenPrompt === 'string' ? hiddenPrompt.trim() : '';
  if (!visiblePromptText && !hiddenPromptText) {
    throw new Error('Generation prompts are empty');
  }

  requestChatForceScrollBottom(generationSession.sessionId);
  try {
    return await generateStructuredInPiSession({
      cwd: directory,
      instructions: hiddenPromptText || undefined,
      schema,
      sessionId: generationSession.sessionId,
      visiblePrompt: visiblePromptText || hiddenPromptText,
    });
  } catch (error) {
    console.error('[git-generation][pi] structured generation failed', {
      kind,
      sessionId: generationSession.sessionId,
      elapsedMs: Date.now() - requestStartedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export async function listGitWorktrees(directory: string): Promise<import('@varin/application-client').GitWorktreeInfo[]> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.list) {
    return runtime.worktree.list(directory);
  }
  if (runtime) return runtime.listGitWorktrees(directory);
  return gitHttp.listGitWorktrees(directory);
}

export async function validateGitWorktree(
  directory: string,
  payload: import('@varin/application-client').CreateGitWorktreePayload
): Promise<import('@varin/application-client').GitWorktreeValidationResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.validate) {
    return runtime.worktree.validate(directory, payload);
  }
  if (runtime?.validateGitWorktree) {
    return runtime.validateGitWorktree(directory, payload);
  }
  return gitHttp.validateGitWorktree(directory, payload);
}

export async function getGitWorktreeBootstrapStatus(
  directory: string,
): Promise<import('@varin/application-client').GitWorktreeBootstrapStatus> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.bootstrapStatus) {
    return runtime.worktree.bootstrapStatus(directory);
  }
  if (runtime?.getGitWorktreeBootstrapStatus) {
    return runtime.getGitWorktreeBootstrapStatus(directory);
  }
  return gitHttp.getGitWorktreeBootstrapStatus(directory);
}

export async function previewGitWorktree(
  directory: string,
  payload: import('@varin/application-client').CreateGitWorktreePayload
): Promise<import('@varin/application-client').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.preview) {
    return runtime.worktree.preview(directory, payload);
  }
  if (runtime?.previewGitWorktree) {
    return runtime.previewGitWorktree(directory, payload);
  }
  return gitHttp.previewGitWorktree(directory, payload);
}

export async function createGitWorktree(
  directory: string,
  payload: import('@varin/application-client').CreateGitWorktreePayload
): Promise<import('@varin/application-client').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.create) {
    return runtime.worktree.create(directory, payload);
  }
  if (runtime?.createGitWorktree) {
    return runtime.createGitWorktree(directory, payload);
  }
  return gitHttp.createGitWorktree(directory, payload);
}

export async function deleteGitWorktree(
  directory: string,
  payload: import('@varin/application-client').RemoveGitWorktreePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.remove) {
    return runtime.worktree.remove(directory, payload);
  }
  if (runtime?.deleteGitWorktree) {
    return runtime.deleteGitWorktree(directory, payload);
  }
  return gitHttp.deleteGitWorktree(directory, payload);
}

export const git = {
  worktree: {
    list: listGitWorktrees,
    validate: validateGitWorktree,
    create: createGitWorktree,
    remove: deleteGitWorktree,
  },
};

export async function createGitCommit(
  directory: string,
  message: string,
  options: import('@varin/application-client').CreateGitCommitOptions = {}
): Promise<import('@varin/application-client').GitCommitResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitCommit(directory, message, options);
  return gitHttp.createGitCommit(directory, message, options);
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<import('@varin/application-client').GitPushResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPush(directory, options);
  return gitHttp.gitPush(directory, options);
}

export async function gitPull(
  directory: string,
  options: import('@varin/application-client').GitPullOptions = {}
): Promise<import('@varin/application-client').GitPullResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPull(directory, options);
  return gitHttp.gitPull(directory, options);
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitFetch(directory, options);
  return gitHttp.gitFetch(directory, options);
}

export async function listGitStashes(directory: string): Promise<{ stashes: import('@varin/application-client').GitStashEntry[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.listGitStashes(directory);
  return gitHttp.listGitStashes(directory);
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.countGitStashFiles(directory, refs);
  return gitHttp.countGitStashFiles(directory, refs);
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashGitChanges(directory, options);
  return gitHttp.stashGitChanges(directory, options);
}

export async function applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.applyGitStash(directory, options);
  return gitHttp.applyGitStash(directory, options);
}

export async function popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.popGitStash(directory, options);
  return gitHttp.popGitStash(directory, options);
}

export async function dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.dropGitStash(directory, options);
  return gitHttp.dropGitStash(directory, options);
}

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutBranch(directory, branch);
  return gitHttp.checkoutBranch(directory, branch);
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createBranch(directory, name, startPoint);
  return gitHttp.createBranch(directory, name, startPoint);
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.renameBranch(directory, oldName, newName);
  return gitHttp.renameBranch(directory, oldName, newName);
}

export async function getGitLog(
  directory: string,
  options: import('@varin/application-client').GitLogOptions = {}
): Promise<import('@varin/application-client').GitLogResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitLog(directory, options);
  return gitHttp.getGitLog(directory, options);
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<import('@varin/application-client').GitCommitFilesResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCommitFiles(directory, hash);
  return gitHttp.getCommitFiles(directory, hash);
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<import('@varin/application-client').CommitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime?.getCommitFileDiff) return runtime.getCommitFileDiff(directory, hash, filePath, isBinary);
  return gitHttp.getCommitFileDiff(directory, hash, filePath, isBinary);
}

export async function getGitIdentities(): Promise<import('@varin/application-client').GitIdentityProfile[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitIdentities();
  return gitHttp.getGitIdentities();
}

export async function createGitIdentity(profile: import('@varin/application-client').GitIdentityProfile): Promise<import('@varin/application-client').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitIdentity(profile);
  return gitHttp.createGitIdentity(profile);
}

export async function updateGitIdentity(id: string, updates: import('@varin/application-client').GitIdentityProfile): Promise<import('@varin/application-client').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.updateGitIdentity(id, updates);
  return gitHttp.updateGitIdentity(id, updates);
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitIdentity(id);
  return gitHttp.deleteGitIdentity(id);
}

export async function getCurrentGitIdentity(directory: string): Promise<import('@varin/application-client').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCurrentGitIdentity(directory);
  return gitHttp.getCurrentGitIdentity(directory);
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime?.hasLocalIdentity) return runtime.hasLocalIdentity(directory);
  return gitHttp.hasLocalIdentity(directory);
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: import('@varin/application-client').GitIdentityProfile }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.setGitIdentity(directory, profileId);
  return gitHttp.setGitIdentity(directory, profileId);
}

export async function discoverGitCredentials(): Promise<import('@varin/application-client').DiscoveredGitCredential[]> {
  const runtime = getRuntimeGit();
  if (runtime?.discoverGitCredentials) return runtime.discoverGitCredentials();
  return gitHttp.discoverGitCredentials();
}

export async function getGlobalGitIdentity(): Promise<import('@varin/application-client').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getGlobalGitIdentity) return runtime.getGlobalGitIdentity();
  return gitHttp.getGlobalGitIdentity();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getRemoteUrl) return runtime.getRemoteUrl(directory, remote);
  return gitHttp.getRemoteUrl(directory, remote);
}

export async function getRemotes(directory: string): Promise<import('@varin/application-client').GitRemote[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getRemotes(directory);
  return gitHttp.getRemotes(directory);
}

export async function removeRemote(
  directory: string,
  payload: import('@varin/application-client').GitRemoveRemotePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.removeRemote(directory, payload);
  return gitHttp.removeRemote(directory, payload);
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<import('@varin/application-client').GitRebaseResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.rebase(directory, options);
  return gitHttp.rebase(directory, options);
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortRebase(directory);
  return gitHttp.abortRebase(directory);
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<import('@varin/application-client').GitMergeResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.merge(directory, options);
  return gitHttp.merge(directory, options);
}

export async function checkoutCommit(
  directory: string,
  hash: string
): Promise<import('@varin/application-client').CheckoutCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutCommit(directory, hash);
  return gitHttp.checkoutCommit(directory, hash);
}

export async function cherryPick(
  directory: string,
  hash: string
): Promise<import('@varin/application-client').CherryPickResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.cherryPick(directory, hash);
  return gitHttp.cherryPick(directory, hash);
}

export async function revertCommit(
  directory: string,
  hash: string
): Promise<import('@varin/application-client').RevertCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertCommit(directory, hash);
  return gitHttp.revertCommit(directory, hash);
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force?: boolean
): Promise<import('@varin/application-client').ResetToCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.resetToCommit(directory, hash, mode, force);
  return gitHttp.resetToCommit(directory, hash, mode, force);
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortMerge(directory);
  return gitHttp.abortMerge(directory);
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueRebase(directory);
  return gitHttp.continueRebase(directory);
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueMerge(directory);
  return gitHttp.continueMerge(directory);
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stash(directory, options);
  return gitHttp.stash(directory, options);
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashPop(directory);
  return gitHttp.stashPop(directory);
}

export async function getConflictDetails(directory: string): Promise<import('@varin/application-client').MergeConflictDetails> {
  const runtime = getRuntimeGit();
  if (runtime?.getConflictDetails) return runtime.getConflictDetails(directory);
  return gitHttp.getConflictDetails(directory);
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const runtime = getRuntimeGit();
  if (runtime?.validateWorktreeDirectory) {
    return runtime.validateWorktreeDirectory(directory, worktreeRoot);
  }
  return gitHttp.validateWorktreeDirectory(directory, worktreeRoot);
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const runtime = getRuntimeGit();
  if (runtime?.canonicalizeWorktreeState) {
    return runtime.canonicalizeWorktreeState(directory);
  }
  return gitHttp.canonicalizeWorktreeState(directory);
}
