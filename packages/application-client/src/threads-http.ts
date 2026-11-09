import { observeMessageTime, parseComputerAutomationProjection, parseComputerAutomationState } from '@varin/protocol';
import { threadSourceFailureMessage, type ThreadsAPI } from './threads.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from './transport/runtime-switch.js';

export class ThreadRequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly admission?: 'not_started', readonly detail?: string) {
    super(code === 'extension-host-unavailable' ? 'The local extension process is unavailable. Restart Varin; if it persists, reinstall the application.'
      : (code === 'workspace_backend_unavailable' || code.startsWith('resource-')) && detail ? detail : threadSourceFailureMessage(code) ?? `Thread request failed (${status})`);
    this.name = 'ThreadRequestError';
  }
}

/** Uses the same Application Host transport/auth selection as the other RuntimeAPIs. */
export function createThreadsHttpAPI(): ThreadsAPI {
  // Image editor source pixels and undo history are local draft state, never request media.
  const imagePayload = (images: readonly import('@varin/protocol').ImageAttachment[]) => images.map(({ data, mimeType, reference }) => ({ data, mimeType, ...(reference === undefined ? {} : { reference }) }));
  const withClientTime = <T extends { clientTime?: import('@varin/protocol').MessageTimeObservation; images?: readonly import('@varin/protocol').ImageAttachment[] }>(input: T) => ({
    ...input, ...(input.images === undefined ? {} : { images: imagePayload(input.images) }), clientTime: input.clientTime ?? observeMessageTime(),
  });
  const post = async <T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const generation = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(`/api/threads/${method}`, { method: 'POST', ...(signal ? { signal } : {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    signal?.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during thread request');
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const failure = body && typeof body === 'object' ? body as { code?: unknown; admission?: unknown; error?: unknown } : {};
      signal?.throwIfAborted();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during thread request');
      throw new ThreadRequestError(response.status, typeof failure.code === 'string' ? failure.code
        : response.status === 413 ? 'http-body-too-large' : 'thread-request-failed',
      failure.admission === 'not_started' ? 'not_started' : undefined, typeof failure.error === 'string' ? failure.error : undefined);
    }
    const result = await response.json() as T;
    signal?.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during thread request');
    return result;
  };
  const attachmentRequest = async <T>(path: string, init: RequestInit, decode: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const generation = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(`/api/threads/attachments/${path}`, { ...init, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during attachment request');
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string; error?: string };
      throw new ThreadRequestError(response.status, error.code ?? 'attachment-request-failed', undefined, error.error);
    }
    const value = await decode(response);
    signal?.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during attachment request');
    return value;
  };
  return {
    conversationTree: (identity, signal) => post('tree', identity, signal),
    treePreview: (identity, range, signal) => post('tree/preview', { ...identity, ...range }, signal),
    workflows: {
      memoryScopes: (identity, signal) => post('memory/scopes', identity, signal),
      remember: input => post('memory/remember', input),
      export: async (selection, destination, signal) => {
        signal?.throwIfAborted();
        const generation = getRuntimeEndpointGeneration();
        const controller = new AbortController();
        const changed = subscribeRuntimeEndpointWillChange(() => controller.abort(new Error('Application Host changed during export')));
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await runtimeFetch('/api/threads/export', { method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection) });
          if (!response.ok) {
            const failure = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(failure.error ?? `Conversation export failed (${response.status})`);
          }
          if (!response.body) throw new Error('The Host did not provide an export stream');
          await response.body.pipeTo(destination, { signal: controller.signal });
          if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during export');
        } catch (error) { await destination.abort(error).catch(() => {}); throw error; }
        finally { changed(); signal?.removeEventListener('abort', abort); }
      },
    },
    attachments: {
      upload: (identity, request, signal) => {
        const query = new URLSearchParams({ ...identity, key: request.key, filename: request.filename, mimeType: request.mimeType, byteLength: String(request.data.size) });
        return attachmentRequest(`upload?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body: request.data }, response => response.json(), signal);
      },
      read: (identity, request, signal) => {
        const query = new URLSearchParams({ ...identity, ref: request.ref });
        return attachmentRequest(`read?${query}`, { method: 'GET' }, response => response.blob(), signal);
      },
    },
    nextStep: (identity, cut, signal) => post('next-step', { ...identity, ...cut }, signal),
    materials: {
      collection: (identity, request, signal) => post('materials/collection', { ...identity, request }, signal),
      upload: (identity, request, signal) => post('materials/upload', { ...identity, request }, signal),
      read: (identity, request, signal) => post('materials/read', { ...identity, request }, signal),
      readSource: (selection, request, signal) => post('materials/read-source', { ...selection, request }, signal),
      readArtifact: (selection, request, signal) => post('materials/read-artifact', { ...selection, request }, signal),
    },
    computer: {
      state: async (identity, signal) => parseComputerAutomationProjection(await post('computer/state', identity, signal)),
      stop: async (identity, request, signal) => {
        const result = await post<{ state: unknown }>('computer/stop', { ...identity, ...request }, signal);
        return { state: parseComputerAutomationState(result.state) };
      },
      decide: async (identity, request, signal) => {
        const result = await post<{ state: unknown }>('computer/decide', { ...identity, ...request }, signal);
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
      control: (identity, request, signal) => post('messages/control', { ...identity, request }, signal),
      feed: (identity, request, signal) => post('messages/feed', { ...identity, request }, signal),
      send: (identity, request, signal) => post('messages/send', { ...identity, request }, signal),
      list: (identity, request, signal) => post('messages/list', { ...identity, request }, signal),
      get: (identity, messageId, signal) => post('messages/get', { ...identity, messageId }, signal),
    },
    family: {
      list: (identity, options, signal) => post('family/list', { ...identity, ...(typeof options === 'boolean' ? { includeSelf: options } : options) }, signal),
      runs: (identity, request, signal) => post('family/runs', { ...identity, request }, signal),
      read: (identity, request, signal) => post('family/read', { ...identity, request }, signal),
      item: (identity, request, signal) => post('family/item', { ...identity, request }, signal),
    },
    processes: { openTerminal: input => post('process/terminal', input) },
    plan: { read: identity => post('plan/read', identity), update: input => post('plan/update', input) },
    collaboration: {
      queuedExchanges: (identity, signal) => post('messages/exchanges/queued', identity, signal),
      controlExchange: (identity, request, signal) => post('messages/exchanges/control', { ...identity, request }, signal),
      dispatchCatalog: (identity, signal) => post('child/dispatch/catalog', identity, signal),
      dispatch: (input, signal) => post('child/dispatch', input, signal),
      exchange: (identity, request, signal) => post('messages/exchange', { ...identity, request }, signal),
      integration: (input, signal) => post('child/integration', input, signal),
      continueChild: (input, signal) => post('child/continue', withClientTime(input), signal),
      executions: (identity, operationId, signal) => post('child/executions', { ...identity, ...(operationId ? { operationId } : {}) }, signal),
      readExecutionReport: (identity, executionId, itemId, offset, maxBytes, signal) => post('child/execution/report', { ...identity, executionId, itemId, offset, maxBytes }, signal),
      children: identity => post('child/list', identity),
      page:(identity,options,signal)=>post('child/page',{...identity,options},signal),
      readReport: (identity, operationId, itemId, offset, maxBytes, signal) => post('child/report', { ...identity, operationId, itemId, offset, maxBytes }, signal),
      cancelChild: (identity, operationId) => post('child/cancel', { ...identity, operationId }),
      cancelWait: (identity, waitId) => post('child/wait/cancel', { ...identity, waitId }),
      cancelTree: identity => post('tree/cancel', identity),
    },
    resources: { refresh: input => post('resources/refresh', input),
      draftSkills: (options, signal) => post('resources/draft-skills', options ?? {}, signal),
      skills: (identity, options, signal) => post('resources/skills', { ...identity, ...options }, signal) },
    followups: {
      jobSources: (identity, runId, signal) => post('followup/jobs', { ...identity, runId }, signal),
      register: input => post('followup/register', input),
      arrangements: (identity, botId, signal) => post('followup/arrangements', { ...identity, botId }, signal),
      eventSources: (identity, signal) => post('followup/event-sources', identity, signal),
      sourceRoutes: (identity, followupId, signal) => post('followup/source-routes', { ...identity, followupId }, signal),
      putSourceRoute: input => post('followup/source-route/put', input),
      removeSourceRoute: input => post('followup/source-route/remove', input),
      putArrangement: input => post('followup/arrangement/put', input),
      backlog: input => post('followup/backlog', input),
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
    list: (options = {}, signal) => post('list', options, signal),
    attention: signal => post('attention', {}, signal),
    update: input => post('update', input), delete: input => post('delete', input), markRead: input => post('read', input),
    deleteBranch: input => post('branch/delete', input),
    listModels: () => post('models', {}),
    selectModel: input => post('model/select',input),
    create: key => post('create', { key }), fork: input => post('fork', input), submit: input => post('submit', withClientTime(input)), enqueue: input => post('enqueue', withClientTime(input)),
    prepareNavigation: input => post('navigation/prepare', input),
    recoverySource: input => post('recovery/source', input),
    navigate: input => post('navigate', input),
    navigationReceipt: input => post('navigation/receipt', input),
    sources: { files: (identity, options, signal) => post('source/files', { ...identity, ...options }, signal),
      draftFiles: (options, signal) => post('source/draft-files', options, signal),
      list: (identity, signal) => post('source/list', identity ?? {}, signal),
      resolve: (identity, request, signal) => post('source/resolve', { ...identity, ...request }, signal) },
    prepareSource: (input, signal) => post('source/prepare', input, signal),
    compact: input => post('context/compact', input),
    publishContext: (identity, runId) => post('context/publish', { ...identity, runId }),
    contextHistory: (identity, runId, cursor) => post('context/history', { ...identity, runId, ...cursor }),
    cancelContext: (identity, runId) => post('context/cancel', { ...identity, runId }),
    async resumeContext(identity, runId) { await post('context/resume', { ...identity, runId }); },
    editInput: (inputId, expectedRevision, text, images, skills) => post('input/edit', { inputId, expectedRevision, text, ...(images === undefined ? {} : { images: imagePayload(images) }), ...(skills === undefined ? {} : { skills }) }),
    cancelInput: (inputId, expectedRevision) => post('input/cancel', { inputId, expectedRevision }),
    sendInputNow: (inputId, expectedRevision, expectedRunId) => post('input/send-now', { inputId, expectedRevision, expectedRunId }),
    mediaRead: (input, signal) => post('media/read', input, signal),
    historyPage: (identity, cursor, signal) => post('history/page', { ...identity, ...cursor }, signal),
    historyRuns: (identity, cursor, signal) => post('history/runs', { ...identity, ...cursor }, signal),
    historyRunPreview: (identity, cursor, signal) => post('history/run-preview', { ...identity, ...cursor }, signal),
    historyUsage: (identity, cursor, signal) => post('history/usage', { ...identity, ...cursor }, signal),
    fileTarget: (input, signal) => post('history/file', input, signal),
    usage: (selected, signal) => post('usage', selected, signal),
    snapshot: (selected, signal) => post('snapshot', selected, signal), run: runId => post('run', { runId }),
    contextInspection: (identity, cursor, signal) => post('context/inspect', { ...identity, ...cursor }, signal),
    inspectTools: (identity, runId) => post('tools/inspect', { ...identity, runId }),
    inspectPolicy: (identity, runId) => post('policy/inspect', { ...identity, runId }),
    restartPolicy: (identity, runId, selectionId) => post('policy/restart', { ...identity, runId, selectionId }),
    cancelPolicyUpdate: (identity, runId, selectionId) => post('policy/cancel', { ...identity, runId, selectionId }),
    cancelRun: runId => post('run/cancel', { runId }), operation: operationId => post('operation', { operationId }),
    toolCalls: (operationId, signal) => post('operation/calls', { operationId }, signal),
    cancelOperation: operationId => post('operation/cancel', { operationId }),
    retrievalTrace: (operationId, cursor, signal) => post('operation/retrieval-trace', { operationId, ...cursor }, signal),
    retrievalFileTarget: (operationId, itemId, path, signal) => post('operation/retrieval-file', { operationId, itemId, path }, signal),
    decidePermission: input => post('permission/decide', input),
    answerQuestion: input => post('question/answer', input),
    listMcpInteractions: (input, signal) => post('mcp/interactions/list', input, signal),
    readMcpInteraction: (input, signal) => post('mcp/interactions/read', input, signal),
    respondMcpInteraction: (input, signal) => post('mcp/interactions/respond', input, signal),
    reviewMcpSamplingRequest: (input, signal) => post('mcp/interactions/sampling/request', input, signal),
    reviewMcpSamplingOutput: (input, signal) => post('mcp/interactions/sampling/output', input, signal),
    resume: (runId, waitId) => post('run/resume', { runId, waitId }),
    async retryPreparation(runId) { await post('run/retry-preparation', { runId }); }, events: cursor => post('events', { cursor }),
    async observe(cursor, listener, { signal }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const remove = subscribeRuntimeEndpointWillChange(abort);
      let response: Response | undefined;
      try {
        response = await runtimeFetch('/api/threads/observe', { query: cursor === null ? {} : { cursor }, signal: controller.signal,
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
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } finally {
        controller.abort();
        remove(); signal.removeEventListener('abort', abort);
        // Rejected responses have no reader. Release their original channel too;
        // flow-controlled observation bodies are not drained in the background.
        await response?.body?.cancel().catch(() => {});
      }
    },
  };
}
