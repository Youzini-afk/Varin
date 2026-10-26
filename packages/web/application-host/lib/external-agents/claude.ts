import type { ExternalItem } from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import { HarnessTransport, record, text } from './transport.js';

export async function connectClaude(
  peer: HarnessTransport,
  launcher: { command: string; args: string[] },
  cwd: string,
  existing?: string,
): Promise<HarnessConnection> {
  let sink: HarnessSink | undefined;
  let finish: ((result: Awaited<ReturnType<HarnessConnection['prompt']>>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let stopped = false;
  let messageId = '';
  const blocks = new Map<number, Omit<ExternalItem, 'turnId'>>();
  const toolItems = new Map<string, Omit<ExternalItem, 'turnId'>>();
  const inputText = new Map<string, string>();
  peer.onMessage((frame) => {
    const message = record(frame.params);
    if (frame.method === 'failure') {
      fail?.(new Error(text(message.message)));
      return;
    }
    if (!sink || frame.method !== 'message') return;
    if (message.type === 'stream_event') {
      const event = record(message.event),
        index = Number(event.index);
      if (event.type === 'message_start') {
        messageId = text(record(event.message).id);
        blocks.clear();
      }
      if (event.type === 'content_block_start') {
        const block = record(event.content_block);
        const item: Omit<ExternalItem, 'turnId'> =
          block.type === 'tool_use'
            ? {
                id: text(block.id),
                kind: 'tool',
                text: '',
                tool: { name: text(block.name), input: block.input, status: 'running' },
              }
            : {
                id: `${messageId}:${index}`,
                kind: block.type === 'thinking' ? 'reasoning' : 'assistant',
                text: text(block.text ?? block.thinking),
              };
        blocks.set(index, item);
        sink.item(item);
        if (item.tool) toolItems.set(item.id, item);
      }
      if (event.type === 'content_block_delta') {
        const old = blocks.get(index),
          delta = record(event.delta);
        if (old && !old.tool) {
          const item = { ...old, text: old.text + text(delta.text ?? delta.thinking) };
          blocks.set(index, item);
          sink.item(item);
        } else if (old?.tool && delta.type === 'input_json_delta') {
          const json = (inputText.get(old.id) ?? '') + text(delta.partial_json);
          inputText.set(old.id, json);
          let input: unknown = json;
          try {
            input = JSON.parse(json);
          } catch {
            /* Keep the received partial JSON visible until complete. */
          }
          const item = { ...old, tool: { ...old.tool, input } };
          blocks.set(index, item);
          toolItems.set(item.id, item);
          sink.item(item);
        }
      }
    }
    if (message.type === 'assistant') {
      const raw = record(message.message);
      const id = text(raw.id);
      for (const [index, value] of (Array.isArray(raw.content) ? raw.content : []).entries()) {
        const block = record(value);
        const item: Omit<ExternalItem, 'turnId'> =
          block.type === 'tool_use'
            ? {
                id: text(block.id),
                kind: 'tool',
                text: '',
                tool: { name: text(block.name), input: block.input, status: 'running' },
              }
            : {
                id: `${id}:${index}`,
                kind: block.type === 'thinking' ? 'reasoning' : 'assistant',
                text: text(block.text ?? block.thinking),
                complete: true,
              };
        if (item.tool) toolItems.set(item.id, item);
        if (item.tool || item.text) sink.item(item);
        if (
          block.type === 'tool_use' &&
          block.name === 'TodoWrite' &&
          Array.isArray(record(block.input).todos)
        )
          sink.item({
            id: 'plan',
            kind: 'plan',
            complete: true,
            text: (record(block.input).todos as unknown[])
              .map((value) => {
                const step = record(value);
                return `- [${step.status === 'completed' ? 'x' : step.status === 'in_progress' ? '/' : ' '}] ${text(step.content)}`;
              })
              .join('\n'),
          });
      }
    }
    if (message.type === 'user')
      for (const value of Array.isArray(record(message.message).content)
        ? (record(message.message).content as unknown[])
        : []) {
        const block = record(value),
          id = text(block.tool_use_id),
          old = toolItems.get(id);
        if (block.type === 'tool_result' && old?.tool)
          sink.item({
            ...old,
            tool: { ...old.tool, output: block.content, status: block.is_error ? 'failed' : 'completed' },
          });
      }
    if (message.type === 'result') {
      const usage = record(message.usage);
      sink.usage({
        input: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        output: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        cachedInput:
          typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
        cacheCreated:
          typeof usage.cache_creation_input_tokens === 'number'
            ? usage.cache_creation_input_tokens
            : undefined,
        inputIncludesCache: false,
        scope: 'turn',
      });
      finish?.({
        status: stopped ? 'cancelled' : message.is_error ? 'failed' : 'completed',
        error: message.is_error
          ? Array.isArray(message.errors)
            ? message.errors.join('\n')
            : text(message.result)
          : undefined,
      });
    }
  });
  peer.onExit((error) => fail?.(error));
  peer.onRequest(async (message) => {
    if (!sink || message.method !== 'permission') throw new Error('Claude interaction has no active turn');
    const p = record(message.params),
      input = record(p.input);
    if (p.name === 'AskUserQuestion') {
      const questions = (Array.isArray(input.questions) ? input.questions : []).map((value, index) => {
        const q = record(value);
        return {
          id: String(index),
          question: text(q.question),
          multiple: q.multiSelect === true,
          options: (Array.isArray(q.options) ? q.options : []).map((value) => ({
            label: text(record(value).label),
            description: text(record(value).description),
          })),
        };
      });
      const response = await sink.interaction({
        id: String(message.id),
        kind: 'question',
        title: 'Claude Code',
        questions,
        options: [],
      });
      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: Object.fromEntries(
            questions.map((q) => [q.question, (response.answers?.[q.id] ?? []).join(', ')]),
          ),
        },
      };
    }
    const suggestions = Array.isArray(p.suggestions) ? p.suggestions : [];
    const options = [
      { id: 'allow', label: 'Allow once' },
      ...(suggestions.length ? [{ id: 'rule', label: 'Allow with the proposed permission rule' }] : []),
      { id: 'deny', label: 'Deny' },
    ];
    const response = await sink.interaction({
      id: String(message.id),
      kind: 'permission',
      title: text(p.name),
      detail: JSON.stringify(input, null, 2),
      options,
    });
    if (response.optionId === 'allow' || response.optionId === 'rule')
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(response.optionId === 'rule' ? { updatedPermissions: suggestions } : {}),
      };
    return { behavior: 'deny', message: 'User declined this operation' };
  });
  const initialized = await peer.request('initialize', {
    launcher,
    cwd,
    ...(existing ? { sessionId: existing } : {}),
  });
  return {
    sessionId: text(initialized.sessionId),
    capabilities: {
      resume: true,
      images: true,
      steering: false,
      models: (Array.isArray(initialized.models) ? initialized.models : []).map((value) => ({
        id: text(record(value).value),
        name: text(record(value).displayName) || text(record(value).value),
        thinkingLevels: Array.isArray(record(value).supportedEffortLevels)
          ? (record(value).supportedEffortLevels as string[])
          : undefined,
      })),
    },
    async prompt(input, next) {
      if (sink) throw new Error('Claude is already running');
      sink = next;
      stopped = false;
      blocks.clear();
      toolItems.clear();
      inputText.clear();
      try {
        const completion = new Promise<Awaited<ReturnType<HarnessConnection['prompt']>>>(
          (resolve, reject) => {
            finish = resolve;
            fail = reject;
          },
        );
        void completion.catch(() => {});
        const accepted = await peer.request('prompt', { ...input });
        if (accepted.cancelled) return { status: 'cancelled' };
        return await completion;
      } finally {
        sink = undefined;
        finish = undefined;
        fail = undefined;
      }
    },
    async stop() {
      stopped = true;
      await peer.request('interrupt');
    },
    close: () => peer.close(),
  };
}
