import type { NativeThreadsAPI } from './native-threads.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from './transport/runtime-switch.js';

export class NativeThreadRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Native thread request failed (${status})`);
    this.name = 'NativeThreadRequestError';
  }
}

/** Uses the same Application Host transport/auth selection as the other RuntimeAPIs. */
export function createNativeThreadsHttpAPI(): NativeThreadsAPI {
  const post = async <T>(method: string, body: unknown): Promise<T> => {
    const generation = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(`/api/native-threads/${method}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during native thread request');
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { code?: unknown };
      throw new NativeThreadRequestError(response.status, typeof failure.code === 'string' ? failure.code
        : response.status === 413 ? 'native-http-body-too-large' : 'native-thread-request-failed');
    }
    const result = await response.json() as T;
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during native thread request');
    return result;
  };
  return {
    plan: { read: identity => post('plan/read', identity), update: input => post('plan/update', input) },
    collaboration: {
      children: identity => post('child/list', identity),
      readReport: (identity, operationId, itemId, offset, maxBytes) => post('child/report', { ...identity, operationId, itemId, offset, maxBytes }),
      cancelChild: (identity, operationId) => post('child/cancel', { ...identity, operationId }),
      cancelWait: (identity, waitId) => post('child/wait/cancel', { ...identity, waitId }),
      async cancelTree(identity) { await post('tree/cancel', identity); },
    },
    list: () => post('list', {}), listModels: () => post('models', {}),
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
    cancelRun: runId => post('run/cancel', { runId }), operation: operationId => post('operation', { operationId }),
    cancelOperation: operationId => post('operation/cancel', { operationId }),
    decidePermission: input => post('permission/decide', input),
    answerQuestion: input => post('question/answer', input),
    async resume(runId) { await post('run/resume', { runId }); }, events: cursor => post('events', { cursor }),
    async observe(cursor, listener, { signal }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const remove = subscribeRuntimeEndpointWillChange(abort);
      try {
        const response = await runtimeFetch('/api/native-threads/observe', { query: { cursor }, signal: controller.signal,
          headers: { Accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error('Native thread event stream unavailable');
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
