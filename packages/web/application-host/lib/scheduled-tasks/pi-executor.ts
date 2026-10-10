import type { HostMethodParams } from '@varin/protocol';
import type { PiRuntimeBroker } from '@varin/runtime-broker';
import type { ScheduledTask, ScheduledTaskExecution } from '../projects/project-config.js';
import type { SessionSettleOutcome } from './session-settle.js';

const buildScheduledInstructions = (execution: ScheduledTaskExecution): string => [
  ...(typeof execution?.agent === 'string' && execution.agent.trim()
    ? [`Use the Pi agent role or profile named "${execution.agent.trim()}" for this turn when it is available.`]
    : []),
].join('\n');

type ScheduledExecutionTask = Pick<ScheduledTask, 'execution'>;

export const buildScheduledPiPrompt = (task: ScheduledExecutionTask): string => {
  const prompt = typeof task?.execution?.prompt === 'string'
    ? task.execution.prompt.trim()
    : '';
  const instructions = buildScheduledInstructions(task?.execution);
  return prompt && instructions ? `${prompt}\n\n${instructions}` : prompt;
};

export const createPiScheduledTaskExecutor = ({ broker, awaitCompletion, forgetCompletion }: {
  broker: Pick<PiRuntimeBroker, 'createSession' | 'requestForSession'>;
  /**
   * Resolves when the session's run actually settles (D-307 W3.6). Without it
   * the task's status is the dispatch receipt, not the run outcome — callers
   * that omit it get the historical "accepted means success" behaviour, so
   * production wiring must always provide one.
   */
  awaitCompletion?: (sessionId: string) => Promise<SessionSettleOutcome>;
  /** Drops a pending waiter when dispatch fails or the goal reaches a terminal
   * state before another agent turn starts. */
  forgetCompletion?: (sessionId: string) => void;
}) => {
  if (!broker || typeof broker.createSession !== 'function' || typeof broker.requestForSession !== 'function') {
    throw new Error('A Pi runtime broker is required for scheduled tasks');
  }

  return async ({ projectPath, task, title, onSessionCreated }: {
    onSessionCreated?: (sessionId: string) => void;
    projectPath: string;
    task: ScheduledExecutionTask;
    title: string;
  }) => {
    if (!task.execution.modelID || !task.execution.providerID) throw new Error('Pi scheduled execution requires its own model selection');
    const snapshot = await broker.createSession(projectPath, title);
    const sessionID = snapshot.sessionId;
    try {
      onSessionCreated?.(sessionID);
      await broker.requestForSession(sessionID, 'model.select', {
        modelId: task.execution.modelID,
        provider: task.execution.providerID,
        sessionId: sessionID,
      });
      if (task.execution.thinkingLevel) {
        await broker.requestForSession(sessionID, 'thinking.select', {
          level: task.execution.thinkingLevel as HostMethodParams<'thinking.select'>['level'],
          sessionId: sessionID,
        });
      }

      const prompt = buildScheduledPiPrompt(task);
      const runAsGoal = task.execution.runAsGoal === true;
      if (runAsGoal) {
        await broker.requestForSession(sessionID, 'session.features.mutate', {
          mutation: {
            objective: typeof task.execution.prompt === 'string' ? task.execution.prompt.trim() : prompt,
            ...(typeof task.execution.goalTokenBudget === 'number'
              && Number.isSafeInteger(task.execution.goalTokenBudget)
              && task.execution.goalTokenBudget > 0
              ? { tokenBudget: task.execution.goalTokenBudget }
              : {}),
            type: 'goal.start',
          },
          sessionId: sessionID,
        });
      }
      const dispatchedAsCommand = prompt.startsWith('/');
      // Register the settle waiter before dispatching so the run's terminal
      // events cannot race past the subscription (D-307 W3.6).
      let completion = awaitCompletion && (!dispatchedAsCommand || runAsGoal)
        ? awaitCompletion(sessionID)
        : null;
      if (dispatchedAsCommand) {
        await broker.requestForSession(sessionID, 'command.execute', {
          command: prompt,
          sessionId: sessionID,
        });
      } else {
        const result = await broker.requestForSession(sessionID, 'agent.prompt', {
          sessionId: sessionID,
          text: prompt,
        });
        if (result.accepted !== true) {
          throw new Error('Pi did not accept the scheduled task prompt');
        }
      }
      // The dispatch receipt is not the result — wait for the actual run to
      // settle, then report the observed outcome (goal terminal state for
      // goal runs, turn completion otherwise).
      while (completion) {
        const outcome = await completion;
        completion = null;
        if (!outcome.settled) {
          throw new Error(outcome.error ?? 'the scheduled session ended before the run settled');
        }
        if (outcome.aborted) {
          throw new Error(outcome.error ?? 'the scheduled run was aborted');
        }
        if (!runAsGoal) break;

        // Register the next waiter before inspecting the Goal. Goal automation
        // reacts to agent_settled asynchronously; otherwise a fast continuation
        // could start and settle between the status read and the next waiter.
        const nextCompletion = awaitCompletion ? awaitCompletion(sessionID) : null;
        const features = await broker.requestForSession(sessionID, 'session.features.get', { sessionId: sessionID })
          .catch(() => null);
        const goal = features && typeof features === 'object'
          ? (features as { goal?: { status?: string; statusReason?: string } }).goal
          : undefined;
        switch (goal?.status) {
          case 'complete':
            forgetCompletion?.(sessionID);
            break;
          case 'blocked':
          case 'budgetLimited':
            forgetCompletion?.(sessionID);
            throw new Error(`scheduled goal ended ${goal.status}: ${goal.statusReason ?? 'no reason recorded'}`);
          case 'paused':
            forgetCompletion?.(sessionID);
            // A follow-up registration parks the goal deliberately — the
            // wait is the continuation, not a failure (D-307).
            if (goal.statusReason === 'waiting') break;
            throw new Error(`scheduled goal paused: ${goal.statusReason ?? 'no reason recorded'}`);
          case 'active':
            if (!nextCompletion) {
              throw new Error('scheduled goal is active but completion tracking is unavailable');
            }
            completion = nextCompletion;
            continue;
          default:
            forgetCompletion?.(sessionID);
            throw new Error('scheduled goal state is unavailable after the run settled');
        }
        break;
      }

      return { dispatchedAsCommand, sessionID };
    } catch (error) {
      forgetCompletion?.(sessionID);
      if (error && typeof error === 'object' && !('sessionID' in error)) {
        Object.defineProperty(error, 'sessionID', {
          configurable: true,
          enumerable: false,
          value: sessionID,
        });
      }
      throw error;
    }
  };
};

export { buildScheduledInstructions };
