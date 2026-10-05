import { THINKING_LEVELS, type ImageAttachment, type ThinkingLevel } from '@varin/protocol';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  CreateMultiRunParams,
  CreateMultiRunResult,
  MultiRunFileAttachment,
} from '@/types/multirun';
import {
  getWorktreeSetupWaitEnabled,
  saveWorktreeSetupCommands,
  type VarinProjectRef,
} from '@/lib/project-config';
import {
  checkVarinGitRepository,
  createVarinWorktree,
  removeVarinWorktree,
  resolveVarinRootTrackingRemote,
} from '@/lib/varinWorktrees';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { usePiSessionStore } from './usePiSessionStore';
import { getMultiRunSessionTitle } from '@/lib/multirun/title';
import { renderPiAgentInvocation } from '@/lib/piAgentInvocation';

const toGitSafeSlug = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '-')
  .replace(/^-+|-+$/g, '');

const stableFallbackSlug = (value: string): string => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `group-${(hash >>> 0).toString(36)}`;
};

const toModelSlug = (providerID: string, modelID: string): string => {
  const provider = toGitSafeSlug(providerID) || 'provider';
  const model = toGitSafeSlug(modelID) || 'model';
  return `${provider}-${model}`;
};

const generateWorktreeNameSeed = (groupSlug: string, modelSlug: string): string => (
  `${groupSlug}/${modelSlug}`
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const isThinkingLevel = (value: string | undefined): value is ThinkingLevel => (
  value !== undefined && THINKING_LEVELS.includes(value as ThinkingLevel)
);

const dataUrlParts = (url: string): { base64: boolean; data: string; mime: string } | null => {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(url);
  if (!match) return null;
  return {
    base64: match[2] !== undefined,
    data: match[3] ?? '',
    mime: match[1] || 'application/octet-stream',
  };
};

const decodeBase64Text = (value: string): string => {
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const isTextAttachment = (mime: string): boolean => (
  mime.startsWith('text/')
  || /\/(?:json|jsonc|javascript|typescript|xml|yaml|x-yaml|toml)(?:$|;)/i.test(mime)
);

const escapeAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const prepareAttachments = (
  files: MultiRunFileAttachment[] | undefined,
): { images: ImageAttachment[]; instructions?: string } => {
  const images: ImageAttachment[] = [];
  const blocks: string[] = [];
  for (const file of files ?? []) {
    const parsed = dataUrlParts(file.url);
    const mime = file.mime || parsed?.mime || 'application/octet-stream';
    if (mime.startsWith('image/') && parsed?.base64) {
      images.push({ data: parsed.data, mimeType: mime });
      continue;
    }
    let body = file.url;
    let encoding = 'data-url';
    if (parsed && isTextAttachment(mime)) {
      try {
        body = parsed.base64 ? decodeBase64Text(parsed.data) : decodeURIComponent(parsed.data);
        encoding = 'text';
      } catch {
        body = file.url;
      }
    }
    blocks.push(
      `<attachment name="${escapeAttribute(file.filename)}" mime="${escapeAttribute(mime)}" encoding="${encoding}">\n${body}\n</attachment>`,
    );
  }
  return {
    images,
    ...(blocks.length === 0
      ? {}
      : { instructions: `The user attached the following files to this run:\n${blocks.join('\n')}` }),
  };
};

const resolveActiveProject = (): VarinProjectRef | null => {
  const projectsState = useProjectsStore.getState();
  const activeProjectId = projectsState.activeProjectId;
  const project = activeProjectId
    ? projectsState.projects.find((entry) => entry.id === activeProjectId)
    : undefined;
  if (project?.path) return { id: project.id, path: project.path };

  const currentDirectory = useDirectoryStore.getState().currentDirectory ?? null;
  if (!currentDirectory?.trim()) return null;
  const normalized = currentDirectory.replace(/\\/g, '/').replace(/\/+$/, '') || currentDirectory;
  return { id: `path:${normalized}`, path: normalized };
};

interface CreatedRun {
  modelID: string;
  prompt: string;
  providerID: string;
  sessionId: string;
  variant?: string;
  worktreePath: string;
}

interface MultiRunState {
  error: string | null;
  isLoading: boolean;
}

interface MultiRunActions {
  clearError(): void;
  createMultiRun(params: CreateMultiRunParams): Promise<CreateMultiRunResult | null>;
}

type MultiRunStore = MultiRunState & MultiRunActions;

export const useMultiRunStore = create<MultiRunStore>()(
  devtools(
    (set) => ({
      error: null,
      isLoading: false,

      createMultiRun: async (params) => {
        const groupName = params.name.trim();
        if (!groupName) {
          set({ error: 'Group name is required' });
          return null;
        }
        if (params.groups.length === 0) {
          set({ error: 'At least one run group is required' });
          return null;
        }
        for (let index = 0; index < params.groups.length; index += 1) {
          const group = params.groups[index];
          if (!group.prompt.trim()) {
            set({ error: `Group ${index + 1}: prompt is required` });
            return null;
          }
          if (group.models.length === 0) {
            set({ error: `Group ${index + 1}: select at least 1 model` });
            return null;
          }
        }

        set({ error: null, isLoading: true });
        try {
          const project = resolveActiveProject();
          if (!project) throw new Error('Select a project');
          const directory = project.path;
          const shouldIsolateRuns = await checkVarinGitRepository(directory) && params.isolateRuns !== false;
          const normalizedGroupSlug = toGitSafeSlug(groupName);
          const groupSlug = normalizedGroupSlug || stableFallbackSlug(groupName);
          const rootTrackingRemote = shouldIsolateRuns
            ? await resolveVarinRootTrackingRemote(directory)
            : null;
          const setupCommands = params.setupCommands?.filter((command) => command.trim().length > 0) ?? [];
          const createdRuns: CreatedRun[] = [];
          const failures: CreateMultiRunResult['failures'] = [];
          const piSessions = usePiSessionStore.getState();

          for (let groupIndex = 0; groupIndex < params.groups.length; groupIndex += 1) {
            const group = params.groups[groupIndex];
            const modelCounts = new Map<string, number>();
            for (const model of group.models) {
              const key = `${model.providerID}:${model.modelID}`;
              modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
            }
            const modelIndexes = new Map<string, number>();

            for (const model of group.models) {
              const key = `${model.providerID}:${model.modelID}`;
              const count = modelCounts.get(key) ?? 1;
              const instance = (modelIndexes.get(key) ?? 0) + 1;
              modelIndexes.set(key, instance);
              const runGroup = params.groups.length > 1 ? `g${groupIndex + 1}` : undefined;
              const modelSlug = toModelSlug(model.providerID, model.modelID);
              const modelPart = count > 1 ? `${modelSlug}/${instance}` : modelSlug;
              const preferredName = runGroup
                ? `${runGroup}/${generateWorktreeNameSeed(groupSlug, modelPart)}`
                : generateWorktreeNameSeed(groupSlug, modelPart);
              const sessionTitle = getMultiRunSessionTitle({
                groupSlug,
                ...(runGroup === undefined ? {} : { runGroup }),
                providerID: model.providerID,
                modelID: model.modelID,
                ...(count > 1 ? { index: instance } : {}),
              });

              let sessionId: string | undefined;
              let worktreeMetadata: Awaited<ReturnType<typeof createVarinWorktree>> | undefined;
              try {
                let worktreePath = directory;
                if (shouldIsolateRuns) {
                  worktreeMetadata = await createVarinWorktree(project, {
                    branchName: preferredName,
                    mode: 'new',
                    preferredName,
                    resolvedRootTrackingRemote: rootTrackingRemote,
                    returnAfterDirectoryCreated: true,
                    setupCommands,
                    startRef: params.worktreeBaseBranch || 'HEAD',
                    worktreeName: preferredName,
                  });
                  worktreePath = worktreeMetadata.path;
                  if (await getWorktreeSetupWaitEnabled(project)) {
                    await waitForWorktreeBootstrap(worktreePath);
                  }
                }

                const snapshot = await piSessions.createSession(
                  worktreePath,
                  sessionTitle,
                  undefined,
                  { id: project.id, kind: 'workspace' },
                );
                sessionId = snapshot.sessionId;
                await piSessions.selectModel(sessionId, {
                  id: model.modelID,
                  provider: model.providerID,
                });
                if (model.variant !== undefined) {
                  if (!isThinkingLevel(model.variant)) {
                    throw new Error(`Unsupported Pi thinking level: ${model.variant}`);
                  }
                  await piSessions.selectThinking(sessionId, model.variant);
                }
                createdRuns.push({
                  modelID: model.modelID,
                  prompt: group.prompt,
                  providerID: model.providerID,
                  sessionId,
                  ...(model.variant === undefined ? {} : { variant: model.variant }),
                  worktreePath,
                });
              } catch (error) {
                if (sessionId) await piSessions.deleteSession(sessionId).catch(() => undefined);
                if (worktreeMetadata) {
                  await removeVarinWorktree(project, worktreeMetadata, { deleteLocalBranch: true })
                    .catch(() => undefined);
                }
                failures.push({
                  message: errorMessage(error),
                  modelID: model.modelID,
                  providerID: model.providerID,
                  stage: 'create',
                });
              }
            }
          }

          if (params.setupCommands !== undefined) {
            void saveWorktreeSetupCommands(project, setupCommands).catch((error) => {
              console.warn('[MultiRun] Failed to save worktree setup commands', error);
            });
          }
          if (createdRuns.length === 0) {
            const detail = failures.map((failure) => failure.message).filter(Boolean).join('; ');
            throw new Error(detail ? `Failed to create any sessions: ${detail}` : 'Failed to create any sessions');
          }

          const attachments = prepareAttachments(params.files);
          await Promise.all(createdRuns.map(async (run) => {
            try {
              const instructionParts = [attachments.instructions]
                .filter((value): value is string => Boolean(value?.trim()));
              const directInstructions = instructionParts.length > 0
                ? instructionParts.join('\n\n')
                : undefined;
              const task = params.agent && directInstructions
                ? `${run.prompt}\n\n<varin-run-instructions>\n${directInstructions}\n</varin-run-instructions>`
                : run.prompt;
              const text = params.agent ? renderPiAgentInvocation(params.agent, task) : task;
              const accepted = await piSessions.prompt(
                run.sessionId,
                text,
                attachments.images.length > 0 ? attachments.images : undefined,
                params.agent ? undefined : directInstructions,
              );
              if (!accepted) throw new Error('The Pi runtime did not accept the prompt');
            } catch (error) {
              failures.push({
                message: errorMessage(error),
                modelID: run.modelID,
                providerID: run.providerID,
                stage: 'start',
              });
            }
          }));

          const sessionIds = createdRuns.map((run) => run.sessionId);
          const firstSessionId = sessionIds[0] ?? null;
          if (firstSessionId) piSessions.setCurrentSession(firstSessionId);
          set({
            error: failures.length > 0
              ? `${failures.length} run${failures.length === 1 ? '' : 's'} failed to create or start`
              : null,
          });
          return { failures, firstSessionId, groupSlug, sessionIds };
        } catch (error) {
          set({ error: errorMessage(error) || 'Failed to create Multi-Run' });
          return null;
        } finally {
          set({ isLoading: false });
        }
      },

      clearError: () => set({ error: null }),
    }),
    { name: 'multirun-store' },
  ),
);
