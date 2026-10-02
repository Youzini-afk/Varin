import { describe, expect, it, vi } from 'vitest';
import type { PiSessionFeatureMutation, PiSessionFeatureState, PiSessionGoalState } from '@varin/protocol';
import { createPiSessionAutomationRuntime } from './runtime.js';
import type { GenerateSmallModelTextInput } from '../small-model/index.js';

const userEntry = {
  id: 'user-1',
  message: { content: 'Implement the feature', role: 'user', timestamp: 1 },
  parentId: null,
  timestamp: '2026-08-02T00:00:00.000Z',
  type: 'message',
};

const assistantEntry = {
  id: 'assistant-1',
  message: {
    api: 'test',
    content: [{ text: 'Implemented and verified the feature.', type: 'text' }],
    model: 'small-test',
    provider: 'faux',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: 2,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 50,
      output: 20,
      totalTokens: 70,
    },
  },
  parentId: 'user-1',
  timestamp: '2026-08-02T00:00:01.000Z',
  type: 'message',
};

const goal: PiSessionGoalState = {
  auditFailStreak: 0,
  blockedStreak: 0,
  createdAt: 1,
  id: 'goal-1',
  objective: 'Implement and verify the feature',
  status: 'active',
  tokenBaseline: 10,
  tokensUsed: 0,
  turnsUsed: 0,
  updatedAt: 1,
};

interface HarnessOptions {
  audit?: { note: string; verdict: 'blocked' | 'complete' | 'continue' };
  emptySuggestions?: boolean;
  nextStepEnabled?: boolean;
  precedingUserEntries?: Array<typeof userEntry>;
  withGoal?: boolean;
}

const requireGoal = (features: PiSessionFeatureState): PiSessionGoalState => {
  if (!features.goal) throw new Error('Expected active goal');
  return features.goal;
};

const stripMutationType = <Mutation extends { type: string }>(mutation: Mutation): Omit<Mutation, 'type'> => {
  const copy: Partial<Mutation> = { ...mutation };
  delete copy.type;
  return copy as Omit<Mutation, 'type'>;
};

const createHarness = ({
  audit = { note: 'Verified.', verdict: 'complete' },
  emptySuggestions = false,
  nextStepEnabled = true,
  precedingUserEntries = [],
  withGoal = true,
}: HarnessOptions = {}) => {
  let features: PiSessionFeatureState = {
    ...(withGoal ? { goal: { ...goal } } : {}),
    revision: 1,
    schemaVersion: 1,
  };
  const prompts: string[] = [];
  const mutations: PiSessionFeatureMutation[] = [];
  const brokerImplementation = {
    requestForSession: vi.fn(async (_sessionId: string, method: string, params: Record<string, unknown>) => {
      if (method === 'session.features.get') return features;
      if (method === 'session.snapshot') return {
        activeTools: [],
        busy: false,
        cwd: 'D:/work',
        features,
        followUp: [],
        followUpMode: 'all',
        queuedMessages: [],
        isCompacting: false,
        isStreaming: false,
        leafId: assistantEntry.id,
        pendingMessageCount: 0,
        retryAttempt: 0,
        sessionId: 'session-1',
        steering: [],
        steeringMode: 'all',
        thinkingLevel: 'medium',
      };
      if (method === 'session.entries') return {
        entries: [...precedingUserEntries, userEntry, assistantEntry],
        leafId: assistantEntry.id,
        scope: 'branch',
        sessionId: 'session-1',
      };
      if (method === 'session.stats') return {
        assistantMessages: 1,
        cost: 0,
        sessionId: 'session-1',
        tokens: { cacheRead: 0, cacheWrite: 0, input: 80, output: 30, total: 110 },
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        userMessages: 1,
      };
      if (method === 'settings.get') return {
        global: { harness: { nextStep: { enabled: nextStepEnabled }, models: { nextStep: { providerId: 'faux', modelId: 'next-step' } } } },
        globalRevision: '1', project: {}, projectRevision: '1', projectTrusted: false,
      };
      if (method === 'session.features.mutate') {
        const mutation = params.mutation as PiSessionFeatureMutation;
        mutations.push(mutation);
        if (mutation.type === 'goal.update') {
          const patch = stripMutationType(mutation);
          features = {
            ...features,
            goal: { ...requireGoal(features), ...patch },
            revision: features.revision + 1,
          };
        } else if (mutation.type === 'assist.set') {
          const { generatedAt = Date.now(), ...assist } = stripMutationType(mutation);
          features = {
            ...features,
            assist: { ...assist, generatedAt },
            revision: features.revision + 1,
          };
        }
        return features;
      }
      if (method === 'agent.prompt') {
        if (typeof params.text !== 'string') throw new Error('Expected prompt text');
        prompts.push(params.text);
        return { accepted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    }),
  };
  const broker = brokerImplementation as unknown as Parameters<typeof createPiSessionAutomationRuntime>[0]['broker'];
  const generateSmallModelText = vi.fn(async ({ system }: GenerateSmallModelTextInput) => ({
    modelID: 'audit-model',
    providerID: 'faux',
    source: 'test',
    text: system?.includes('Audit a coding agent')
      ? JSON.stringify(audit)
      : JSON.stringify({ suggestions: emptySuggestions ? [] : ['Package the application.', 'Review the result.'] }),
  }));
  return {
    broker,
    generateSmallModelText,
    get features() { return features; },
    mutations,
    prompts,
  };
};

describe('Pi-native session automation', () => {
  it('settles an independently verified goal without sending another turn', async () => {
    const harness = createHarness();
    const onGoalSettled = vi.fn(() => {});
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
      onGoalSettled,
    });
    await runtime.runGoalNow('session-1');
    expect(requireGoal(harness.features).status).toBe('complete');
    expect(requireGoal(harness.features).tokensUsed).toBe(100);
    expect(requireGoal(harness.features).lastEvaluatedEntryId).toBe('assistant-1');
    expect(harness.prompts).toEqual([]);
    expect(onGoalSettled).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('persists progress before dispatching an accepted continuation', async () => {
    const harness = createHarness({ audit: { note: 'More work remains.', verdict: 'continue' } });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
    });
    await runtime.runGoalNow('session-1');
    expect(requireGoal(harness.features).status).toBe('active');
    expect(requireGoal(harness.features).turnsUsed).toBe(1);
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain('Implement and verify the feature');
    runtime.stop();
  });

  it('stores multiple next-step candidates on the Pi session branch', async () => {
    const harness = createHarness({ withGoal: false });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
    });
    await runtime.runAssistNow('session-1');
    expect(harness.features.assist).toMatchObject({
      forEntryId: 'assistant-1',
      suggestions: ['Package the application.', 'Review the result.'],
    });
    runtime.stop();
  });

  it('includes ordered supplemental user messages in the short facts request', async () => {
    const harness = createHarness({
      precedingUserEntries: [{
        ...userEntry,
        id: 'user-0',
        message: { content: 'Also preserve this correction.', role: 'user', timestamp: 0 },
      }],
      withGoal: false,
    });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
    });
    await runtime.runAssistNow('session-1');
    const prompt = harness.generateSmallModelText.mock.calls[0]?.[0]?.prompt ?? '';
    expect(prompt.indexOf('Also preserve this correction.')).toBeLessThan(prompt.indexOf('Implement the feature'));
    runtime.stop();
  });

  it('does not call a model while next-step selection is disabled', async () => {
    const harness = createHarness({ nextStepEnabled: false, withGoal: false });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
    });
    await runtime.runAssistNow('session-1');
    expect(harness.generateSmallModelText).not.toHaveBeenCalled();
    expect(harness.features.assist).toBeUndefined();
    runtime.stop();
  });

  it('records an empty result and does not issue a second request for the same entry', async () => {
    const harness = createHarness({ emptySuggestions: true, withGoal: false });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
    });
    await runtime.runAssistNow('session-1');
    await runtime.runAssistNow('session-1');
    expect(harness.generateSmallModelText).toHaveBeenCalledTimes(1);
    expect(harness.features.assist).toMatchObject({ forEntryId: 'assistant-1', suggestions: [] });
    runtime.stop();
  });
});
