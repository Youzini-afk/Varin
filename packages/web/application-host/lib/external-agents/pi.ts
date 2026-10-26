import type { ExternalAgentCapabilities, ExternalItem } from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import { HarnessTransport, record, text, type RecordValue } from './transport.js';

export async function connectPi(peer: HarnessTransport, existing?: string): Promise<HarnessConnection> {
  const state = await peer.request('get_state');
  const sessionId = text(state.sessionFile) || text(state.sessionId);
  if (!sessionId || (existing && existing !== sessionId))
    throw new Error('Pi did not restore the selected session');
  let modelsError: string | undefined;
  const available: RecordValue = await peer.request('get_available_models').catch((error) => {
    modelsError = String(error);
    return {};
  });
  const capabilities: ExternalAgentCapabilities = {
    resume: true,
    images: true,
    steering: false,
    modelsError,
    models: (Array.isArray(available.models) ? available.models : []).map((value) => {
      const m = record(value);
      return {
        id: `${text(m.provider)}/${text(m.id)}`,
        name: text(m.name) || text(m.id),
        thinkingLevels: m.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] : undefined,
      };
    }),
  };
  let sink: HarnessSink | undefined;
  let finish: ((result: Awaited<ReturnType<HarnessConnection['prompt']>>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let stopped = false;
  let messageNumber = 0;
  let currentMessage = '';
  const tools = new Map<string, Omit<ExternalItem, 'turnId'>>();
  const messageUsage = new Map<string, RecordValue>();
  const assistant = (message: RecordValue, complete: boolean) => {
    const content = Array.isArray(message.content) ? message.content : [];
    const normal = content
      .filter((value) => record(value).type === 'text')
      .map((value) => text(record(value).text))
      .join('\n');
    const reasoning = content
      .filter((value) => record(value).type === 'thinking')
      .map((value) => text(record(value).thinking))
      .join('\n');
    if (normal) sink?.item({ id: currentMessage, kind: 'assistant', text: normal, complete });
    if (reasoning)
      sink?.item({ id: `${currentMessage}:thinking`, kind: 'reasoning', text: reasoning, complete });
    const usage = record(message.usage);
    if (Object.keys(usage).length) {
      messageUsage.set(currentMessage, usage);
      const sum = (field: string) => {
        const values = [...messageUsage.values()]
          .map((v) => v[field])
          .filter((v): v is number => typeof v === 'number');
        return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
      };
      sink?.usage({
        input: sum('input'),
        output: sum('output'),
        cachedInput: sum('cacheRead'),
        cacheCreated: sum('cacheWrite'),
        inputIncludesCache: false,
        scope: 'turn',
      });
    }
  };
  peer.onMessage((event) => {
    if (!sink) return;
    if (event.type === 'message_start' && record(event.message).role === 'assistant')
      currentMessage = `assistant:${++messageNumber}`;
    if (
      (event.type === 'message_update' || event.type === 'message_end') &&
      record(event.message).role === 'assistant'
    )
      assistant(record(event.message), event.type === 'message_end');
    if (event.type === 'tool_execution_start') {
      const id = text(event.toolCallId);
      const item: Omit<ExternalItem, 'turnId'> = {
        id,
        kind: 'tool',
        text: '',
        tool: { name: text(event.toolName), input: event.args, status: 'running' },
      };
      tools.set(id, item);
      sink.item(item);
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const id = text(event.toolCallId),
        previous = tools.get(id);
      if (previous?.tool) {
        const item = {
          ...previous,
          tool: {
            ...previous.tool,
            output: event.result ?? event.partialResult,
            status:
              event.type === 'tool_execution_update'
                ? ('running' as const)
                : event.isError
                  ? ('failed' as const)
                  : ('completed' as const),
          },
        };
        tools.set(id, item);
        sink.item(item);
      }
    }
    if (event.type === 'extension_ui_request') {
      const method = text(event.method);
      const id = text(event.id);
      if (method === 'notify' || method === 'setStatus') {
        sink.item({ id, kind: 'notice', text: text(event.message ?? event.text) });
        return;
      }
      const options =
        method === 'confirm'
          ? [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ]
          : (Array.isArray(event.options) ? event.options : []).map((value) => ({
              id: String(value),
              label: String(value),
            }));
      if (!['select', 'confirm', 'input', 'editor'].includes(method)) {
        void peer
          .send({ type: 'extension_ui_response', id, cancelled: true })
          .catch((error) => fail?.(error));
        return;
      }
      void sink
        .interaction({
          id,
          kind: 'question',
          title: text(event.title) || 'Pi',
          detail: text(event.message),
          options,
        })
        .then((answer) =>
          peer.send({
            type: 'extension_ui_response',
            id,
            value: method === 'confirm' ? answer.optionId === 'yes' : (answer.optionId ?? answer.text ?? ''),
            cancelled: false,
          }),
        )
        .catch((error) => fail?.(error));
    }
    if (event.type === 'agent_end') {
      const messages = Array.isArray(event.messages) ? event.messages.map(record) : [];
      const error = messages.find((m) => m.role === 'assistant' && m.stopReason === 'error');
      finish?.({
        status: stopped ? 'cancelled' : error ? 'failed' : 'completed',
        error: error ? text(error.errorMessage) : undefined,
      });
    }
  });
  peer.onExit((error) => fail?.(error));
  return {
    sessionId,
    capabilities,
    async prompt(input, next) {
      if (sink) throw new Error('Pi is already running');
      sink = next;
      stopped = false;
      messageNumber = 0;
      tools.clear();
      messageUsage.clear();
      try {
        if (input.model) {
          const slash = input.model.indexOf('/');
          if (slash < 1) throw new Error('Pi model must include its provider');
          await peer.request('set_model', {
            provider: input.model.slice(0, slash),
            modelId: input.model.slice(slash + 1),
          });
        }
        if (input.thinking) await peer.request('set_thinking_level', { level: input.thinking });
        if (stopped) return { status: 'cancelled' };
        const completion = new Promise<Awaited<ReturnType<HarnessConnection['prompt']>>>(
          (resolve, reject) => {
            finish = resolve;
            fail = reject;
          },
        );
        void completion.catch(() => {});
        await peer.request('prompt', {
          message: input.text,
          ...(input.images?.length
            ? {
                images: input.images.map((image) => ({
                  type: 'image',
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              }
            : {}),
        });
        return await completion;
      } finally {
        sink = undefined;
        finish = undefined;
        fail = undefined;
      }
    },
    async stop() {
      stopped = true;
      await peer.request('abort');
    },
    close: () => peer.close(),
  };
}
