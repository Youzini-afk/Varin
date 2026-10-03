import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { SessionSnapshot } from '@varin/protocol';
import type { CreateGitWorktreePayload, RuntimeAPIs } from '@varin/application-client';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useDirectoryStore } from './useDirectoryStore';
import { usePiSessionStore } from './usePiSessionStore';
import { useProjectsStore } from './useProjectsStore';
import { useSnippetsStore } from './useSnippetsStore';
import { useMultiRunStore } from './useMultiRunStore';

const worktreeCreateCalls: Array<{ directory: string; payload: CreateGitWorktreePayload }> = [];
const operationOrder: string[] = [];
const createdSessions: Array<{ cwd: string; name?: string; sessionId: string }> = [];
const selectedModels: Array<{ id: string; model: { id: string; provider: string } }> = [];
const selectedThinking: Array<{ id: string; level: string }> = [];
const prompts: Array<{ id: string; images?: unknown[]; instructions?: string; text: string }> = [];
const deletedSessions: string[] = [];
let currentSessionId: string | null = null;
let isGitRepository = false;
let sessionCounter = 0;

const snapshot = (cwd: string, sessionId: string): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'off',
});

const piSessionOverrides = {
  createSession: async (cwd: string, name?: string) => {
    const sessionId = `ses_${++sessionCounter}`;
    operationOrder.push(`createSession:${cwd}`);
    createdSessions.push({ cwd, name, sessionId });
    return snapshot(cwd, sessionId);
  },
  deleteSession: async (sessionId: string) => {
    deletedSessions.push(sessionId);
    return true;
  },
  prompt: async (id: string, text: string, images?: unknown[], instructions?: string) => {
    prompts.push({ id, text, ...(images === undefined ? {} : { images }), ...(instructions === undefined ? {} : { instructions }) });
    return true;
  },
  selectModel: async (id: string, model: { id: string; provider: string }) => {
    selectedModels.push({ id, model });
    return snapshot('/repo', id);
  },
  selectThinking: async (id: string, level: string) => {
    selectedThinking.push({ id, level });
    return snapshot('/repo', id);
  },
  setCurrentSession: (id: string | null) => { currentSessionId = id; },
};

describe('useMultiRunStore', () => {
  beforeEach(() => {
    worktreeCreateCalls.length = 0;
    operationOrder.length = 0;
    createdSessions.length = 0;
    selectedModels.length = 0;
    selectedThinking.length = 0;
    prompts.length = 0;
    deletedSessions.length = 0;
    currentSessionId = null;
    isGitRepository = false;
    sessionCounter = 0;
    registerRuntimeAPIs({
      documents: {
        read: async (resource: { workspaceId: string; resourceId: string }) => ({ status: 'missing', resource }),
        resolveWorkspace: async () => ({ hostId: 'test-host', workspaceId: 'home' }),
      },
      files: {
        createDirectory: async () => ({ success: true }),
        getHomeDirectory: async () => '/home/test',
      },
      git: {
        checkIsGitRepository: async () => isGitRepository,
        getGitBranches: async () => ({
          all: ['main'],
          branches: { main: { commit: 'abc123', current: true, label: 'main', name: 'main' } },
          current: 'main',
        }),
        getGitStatus: async () => ({
          ahead: 0,
          behind: 0,
          current: 'main',
          files: [],
          isClean: true,
          tracking: null,
        }),
        worktree: {
          create: async (directory: string, payload: CreateGitWorktreePayload) => {
            worktreeCreateCalls.push({ directory, payload });
            const name = String(payload.worktreeName ?? 'worktree');
            return {
              branch: String(payload.branchName ?? 'branch'),
              head: 'abc123',
              name,
              path: `/repo-worktrees/${name}`,
            };
          },
          remove: async () => ({ success: true }),
        },
      },
    } as unknown as RuntimeAPIs);
    useDirectoryStore.setState({ currentDirectory: '/repo' });
    useProjectsStore.setState({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    });
    usePiSessionStore.setState(
      piSessionOverrides as unknown as Partial<ReturnType<typeof usePiSessionStore.getState>>,
    );
    useSnippetsStore.setState({ expandText: (value: string) => Promise.resolve(value) });
    useMultiRunStore.setState({ error: null, isLoading: false });
  });

  test('creates and starts Pi sessions with the selected model and thinking level', async () => {
    const result = await useMultiRunStore.getState().createMultiRun({
      groups: [{
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high' }],
        prompt: 'Fix it',
      }],
      isolateRuns: false,
      name: 'Fix thing',
    });

    expect(result).toEqual({
      failures: [],
      firstSessionId: 'ses_1',
      groupSlug: 'fix-thing',
      sessionIds: ['ses_1'],
    });
    expect(selectedModels).toEqual([{ id: 'ses_1', model: { id: 'claude-sonnet', provider: 'anthropic' } }]);
    expect(selectedThinking).toEqual([{ id: 'ses_1', level: 'high' }]);
    expect(prompts).toEqual([{ id: 'ses_1', text: 'Fix it' }]);
    expect(currentSessionId).toBe('ses_1');
  });

  test('uses fast worktree creation through the Varin Git runtime', async () => {
    isGitRepository = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'anthropic', modelID: 'claude-sonnet' }] }],
      isolateRuns: true,
      name: 'Fix thing',
    });

    expect(result?.sessionIds).toEqual(['ses_1']);
    expect(worktreeCreateCalls).toHaveLength(1);
    expect(worktreeCreateCalls[0]?.payload.returnAfterDirectoryCreated).toBe(true);
    expect(worktreeCreateCalls[0]?.payload.branchName).toBe('fix-thing/anthropic-claude-sonnet');
    expect(worktreeCreateCalls[0]?.payload.worktreeName).toBe('fix-thing-anthropic-claude-sonnet');
    expect(operationOrder).toEqual([
      'createSession:/repo-worktrees/fix-thing-anthropic-claude-sonnet',
    ]);
  });

  test('does not impose an arbitrary model-count cap', async () => {
    const models = Array.from({ length: 8 }, (_, index) => ({
      modelID: `model-${index + 1}`,
      providerID: 'test',
    }));
    const result = await useMultiRunStore.getState().createMultiRun({
      groups: [{ models, prompt: 'Run it' }],
      isolateRuns: false,
      name: 'Many runs',
    });

    expect(result?.sessionIds).toHaveLength(8);
    expect(prompts).toHaveLength(8);
    expect(useMultiRunStore.getState().error).toBeNull();
  });

  test('uses the invocation contract supplied by the owning Pi plugin', async () => {
    await useMultiRunStore.getState().createMultiRun({
      agent: {
        id: 'pi-subagents:delegatable:worker',
        invocation: { command: 'run', kind: 'slash-command', taskSeparator: 'space' },
        name: 'worker',
        providerId: 'pi-subagents',
      },
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'test', modelID: 'model' }] }],
      isolateRuns: false,
      name: 'Delegated',
    });

    expect(prompts[0]?.text).toBe('/run worker Fix it');

    await useMultiRunStore.getState().createMultiRun({
      agent: {
        id: 'pi-subagents:workflow:verify',
        invocation: { command: 'run-chain', kind: 'slash-command', taskSeparator: 'double-dash' },
        name: 'verify',
        providerId: 'pi-subagents',
      },
      groups: [{ prompt: 'Audit it', models: [{ providerID: 'test', modelID: 'model' }] }],
      isolateRuns: false,
      name: 'Workflow',
    });

    expect(prompts[1]?.text).toBe('/run-chain verify -- Audit it');
  });

  test('passes images natively and text files as hidden Pi instructions', async () => {
    await useMultiRunStore.getState().createMultiRun({
      files: [
        { filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' },
        { filename: 'notes.txt', mime: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' },
      ],
      groups: [{ prompt: 'Inspect', models: [{ providerID: 'test', modelID: 'model' }] }],
      isolateRuns: false,
      name: 'Attachments',
    });

    expect(prompts[0]?.images).toEqual([{ data: 'aW1hZ2U=', mimeType: 'image/png' }]);
    expect(prompts[0]?.instructions).toContain('<attachment name="notes.txt"');
    expect(prompts[0]?.instructions).toContain('hello');
  });
});

afterAll(() => registerRuntimeAPIs(null));
