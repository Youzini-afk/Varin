import { parseComputerAutomationProjection, parseComputerAutomationState } from '@varin/protocol';
import type { ThreadsAPI } from './threads.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from './transport/runtime-switch.js';

export class ThreadRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Thread request failed (${status})`);
    this.name = 'ThreadRequestError';
  }
}

/** Uses the same Application Host transport/auth selection as the other RuntimeAPIs. */
export function createThreadsHttpAPI(): ThreadsAPI {
  const post = async <T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const generation = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(`/api/threads/${method}`, { method: 'POST', ...(signal ? { signal } : {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    signal?.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during thread request');
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { code?: unknown };
      signal?.throwIfAborted();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during thread request');
      throw new ThreadRequestError(response.status, typeof failure.code === 'string' ? failure.code
        : response.status === 413 ? 'http-body-too-large' : 'thread-request-failed');
    }
    const result = await response.json() as T;
    signal?.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during thread request');
    return result;
  };
  return {
    computer: {
      state: async (identity, signal) => parseComputerAutomationProjection(await post('computer/state', identity, signal)),
      stop: async (identity, request, signal) => {
        const result = await post<{ state: unknown }>('computer/stop', { ...identity, ...request }, signal);
        return { state: parseComputerAutomationState(result.state) };
      },
    },
    research: {
      scopes: (identity, signal) => post('research/scopes', identity, signal),
      list: (selection, request = {}, signal) => post('research/list', { ...selection, request }, signal),
      get: (selection, attemptId, signal) => post('research/get', { ...selection, attemptId }, signal),
      logs: (selection, request, signal) => post('research/logs', { ...selection, request }, signal),
      artifact: (selection, request, signal) => post('research/artifact', { ...selection, request }, signal),
      cancel: (selection, attemptId) => post('research/cancel', { ...selection, attemptId }),
      collect: (selection, attemptId) => post('research/collect', { ...selection, attemptId }),
      submit: (selection, request) => post('research/submit', { ...selection, request }),
      resources: (selection, signal) => post('research/resources', selection, signal),
      sources: (selection, request = {}, signal) => post('research/sources', { ...selection, request }, signal),
    },
    messages: {
      send: (identity, request, signal) => post('messages/send', { ...identity, request }, signal),
      list: (identity, request, signal) => post('messages/list', { ...identity, request }, signal),
      get: (identity, messageId, signal) => post('messages/get', { ...identity, messageId }, signal),
    },
    family: {
      list: (identity, includeSelf, signal) => post('family/list', { ...identity, includeSelf }, signal),
      runs: (identity, request, signal) => post('family/runs', { ...identity, request }, signal),
      read: (identity, request, signal) => post('family/read', { ...identity, request }, signal),
      item: (identity, request, signal) => post('family/item', { ...identity, request }, signal),
    },
    processes: { openTerminal: input => post('process/terminal', input) },
    plan: { read: identity => post('plan/read', identity), update: input => post('plan/update', input) },
    collaboration: {
      continueChild: (input, signal) => post('child/continue', input, signal),
      executions: (identity, operationId, signal) => post('child/executions', { ...identity, ...(operationId ? { operationId } : {}) }, signal),
      readExecutionReport: (identity, executionId, itemId, offset, maxBytes, signal) => post('child/execution/report', { ...identity, executionId, itemId, offset, maxBytes }, signal),
      children: identity => post('child/list', identity),
      readReport: (identity, operationId, itemId, offset, maxBytes) => post('child/report', { ...identity, operationId, itemId, offset, maxBytes }),
      cancelChild: (identity, operationId) => post('child/cancel', { ...identity, operationId }),
      cancelWait: (identity, waitId) => post('child/wait/cancel', { ...identity, waitId }),
      cancelTree: identity => post('tree/cancel', identity),
    },
    resources: { refresh: input => post('resources/refresh', input) },
    followups: {
      jobSources: (identity, runId, signal) => post('followup/jobs', { ...identity, runId }, signal),
      register: input => post('followup/register', input),
      pendingRegistrations: (identity, signal) => post('followup/registrations/pending', identity, signal),
      cancelRegistration: input => post('followup/registration/cancel', input),
      list: (identity, signal) => post('followup/list', identity, signal),
      get: (identity, followupId, signal) => post('followup/get', { ...identity, followupId }, signal),
      occurrences: (identity, followupId, after, signal) => post('followup/occurrences', { ...identity, followupId, ...(after === undefined ? {} : { after }) }, signal),
      occurrence: (identity, followupId, occurrenceId, signal) => post('followup/occurrence', { ...identity, followupId, occurrenceId }, signal),
      control: input => post('followup/control', input),
    },
    goals: {
      start: input => post('goal/start', input),
      update: input => post('goal/update', input),
      control: input => post('goal/control', input),
      list: identity => post('goal/list', identity),
    },
    list: () => post('list', {}), listModels: () => post('models', {}),
    selectModel: input => post('model/select',input),
    create: key => post('create', { key }), fork: input => post('fork', input), submit: input => post('submit', input), enqueue: input => post('enqueue', input),
    prepareSource: input => post('source/prepare', input),
    compact: input => post('context/compact', input),
    publishContext: (identity, runId) => post('context/publish', { ...identity, runId }),
    cancelContext: (identity, runId) => post('context/cancel', { ...identity, runId }),
    async resumeContext(identity, runId) { await post('context/resume', { ...identity, runId }); },
    editInput: (inputId, expectedRevision, text, images) => post('input/edit', { inputId, expectedRevision, text, ...(images === undefined ? {} : { images }) }),
    cancelInput: (inputId, expectedRevision) => post('input/cancel', { inputId, expectedRevision }),
    historyPage: (identity, cursor) => post('history/page', { ...identity, ...cursor }),
    snapshot: selected => post('snapshot', selected), run: runId => post('run', { runId }),
    inspectTools: (identity, runId) => post('tools/inspect', { ...identity, runId }),
    inspectPolicy: (identity, runId) => post('policy/inspect', { ...identity, runId }),
    restartPolicy: (identity, runId, selectionId) => post('policy/restart', { ...identity, runId, selectionId }),
    cancelPolicyUpdate: (identity, runId, selectionId) => post('policy/cancel', { ...identity, runId, selectionId }),
    cancelRun: runId => post('run/cancel', { runId }), operation: operationId => post('operation', { operationId }),
    cancelOperation: operationId => post('operation/cancel', { operationId }),
    decidePermission: input => post('permission/decide', input),
    answerQuestion: input => post('question/answer', input),
    resume: (runId, waitId) => post('run/resume', { runId, waitId }),
    async retryPreparation(runId) { await post('run/retry-preparation', { runId }); }, events: cursor => post('events', { cursor }),
    async observe(cursor, listener, { signal }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const remove = subscribeRuntimeEndpointWillChange(abort);
      try {
        const response = await runtimeFetch('/api/threads/observe', { query: { cursor }, signal: controller.signal,
          headers: { Accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error('Thread event stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!controller.signal.aborted) {
            const part = await reader.read();
            if (part.done) return;
            buffer += decoder.decode(part.value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
              if (data) listener(JSON.parse(data));
            }
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
      } finally { remove(); signal.removeEventListener('abort', abort); }
    },
  };
}
