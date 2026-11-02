import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi, type Mock } from 'vitest';
import type { ExternalItem } from '@varin/application-client';
import type { KernelManagedProcess } from '../kernel/process-service.js';
import type { HarnessSink } from './adapter.js';
import { connectAcp } from './acp.js';
import { HarnessTransport, record, type RecordValue } from './transport.js';
import { ACP_PROFILES, getAcpProfile } from './profiles.js';

const peers: HarnessTransport[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});

// The adapter and transport are real; only the remote process and its wire replies are controlled.
// ACP v1 frames follow schema-v1.21.0. Dialect shapes are captured in Codeg 6e7e3c3
// connection.rs: Qoder elicitation tests, Grok sessionConfig/model broadcasts and ask-user callbacks.
// These fixtures prove Varin's protocol mapping, not installed CLI/account compatibility.
function fixture(
  input: {
    init?: RecordValue;
    opened?: RecordValue;
    handle?: (
      message: RecordValue,
      reply: (request: RecordValue, result: unknown) => void,
    ) => boolean;
  } = {},
) {
  const sent: RecordValue[] = [];
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  let complete!: () => void;
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitConfirmed: false,
    completion: new Promise<void>((resolve) => {
      complete = resolve;
    }),
    release: vi.fn(async () => {}),
    discardOutput: vi.fn(),
    requestTermination: vi.fn(async () => {
      child.exitConfirmed = true;
      stdout.end();
      complete();
    }),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = record(JSON.parse(String(chunk)));
        sent.push(message);
        queueMicrotask(() => {
          if (input.handle?.(message, reply)) return;
          if (message.method === 'initialize')
            reply(
              message,
              input.init ?? {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  promptCapabilities: { image: true },
                },
              },
            );
          if (
            ['session/new', 'session/load', 'session/resume'].includes(
              String(message.method),
            )
          )
            reply(message, input.opened ?? { sessionId: 'native-session' });
          if (message.method === 'authenticate') reply(message, {});
        });
        callback();
      },
    }),
  });
  const emit = (message: unknown) =>
    stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (request: RecordValue, result: unknown) => {
    emit({ jsonrpc: '2.0', id: request.id, result });
  };
  const peer = new HarnessTransport(child as unknown as KernelManagedProcess);
  peers.push(peer);
  return {
    peer,
    child,
    sent,
    emit,
    reply,
    update(update: RecordValue, sessionId = 'native-session') {
      emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update },
      });
    },
    latest(method: string) {
      return sent.filter((message) => message.method === method).at(-1)!;
    },
    response(id: string) {
      return sent.find(
        (message) => message.id === id && Object.hasOwn(message, 'result'),
      );
    },
  };
}
function sink(): HarnessSink & {
  item: Mock<HarnessSink['item']>;
  usage: Mock<HarnessSink['usage']>;
  interaction: Mock<HarnessSink['interaction']>;
} {
  return {
    item: vi.fn<HarnessSink['item']>(),
    usage: vi.fn<HarnessSink['usage']>(),
    interaction: vi.fn<HarnessSink['interaction']>(async () => ({
      cancelled: true,
    })),
  };
}
const select = (
  id: string,
  category: string,
  currentValue: string,
  values: string[],
) => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue,
  options: [
    {
      group: 'group',
      name: 'Available',
      options: values.map((value) => ({ value, name: value })),
    },
  ],
});
async function promptSent(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.latest('session/prompt')).toBeDefined());
}

it.each(ACP_PROFILES)(
  'connects $name through ACP without granting Host tools or bypass policy',
  async (profile) => {
    const f = fixture(),
      connection = await connectAcp(f.peer, '/workspace', undefined, {
        profile,
      });
    const initialize = record(f.latest('initialize').params);
    expect(initialize.clientCapabilities).toEqual({
      elicitation: { form: {} },
      session: { configOptions: { boolean: {} } },
    });
    expect(f.sent.some((message) => message.method === 'authenticate')).toBe(
      false,
    );
    expect(connection.sessionId).toBe('native-session');
    const pending = connection.prompt({ text: 'Hello' }, sink());
    await promptSent(f);
    expect(record(f.latest('session/prompt').params).sessionId).toBe(
      'native-session',
    );
    f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
    await expect(pending).resolves.toEqual({ status: 'completed' });
  },
);

it('negotiates resume-only recovery and never replaces a failed saved session', async () => {
  const f = fixture({
    init: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    },
    handle: (message) => {
      if (message.method !== 'session/resume') return false;
      f.emit({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32002, message: 'Session unavailable' },
      });
      return true;
    },
  });
  await expect(connectAcp(f.peer, '/workspace', 'saved')).rejects.toThrow(
    'Session unavailable',
  );
  expect(f.sent.map((message) => message.method)).toEqual([
    'initialize',
    'session/resume',
  ]);
  expect(record(f.latest('session/resume').params)).toMatchObject({
    sessionId: 'saved',
  });
});

it('rejects unsupported restoration and a substituted native identity', async () => {
  const unsupported = fixture({
    init: { protocolVersion: 1, agentCapabilities: {} },
  });
  await expect(
    connectAcp(unsupported.peer, '/workspace', 'saved'),
  ).rejects.toMatchObject({ code: 'resume_unsupported' });
  expect(unsupported.sent).toHaveLength(1);
  const changed = fixture({ opened: { sessionId: 'other' } });
  await expect(connectAcp(changed.peer, '/workspace', 'saved')).rejects.toThrow(
    'changed the saved session identity',
  );
});

it('exposes authentication requirements, authenticates only an explicitly selected advertised method before opening', async () => {
  const methods = [
    { id: 'cached_token', name: 'Existing sign-in' },
    {
      id: 'terminal',
      name: 'CLI login',
      type: 'terminal',
      command: 'agent',
      args: ['login'],
    },
  ];
  const init = {
    protocolVersion: 1,
    authMethods: methods,
    agentCapabilities: { loadSession: true },
  };
  const blocked = fixture({
    init,
    handle: (message) => {
      if (message.method !== 'session/new') return false;
      blocked.emit({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'Authentication required' },
      });
      return true;
    },
  });
  await expect(
    connectAcp(blocked.peer, '/workspace', undefined, {
      profile: getAcpProfile('grok'),
    }),
  ).rejects.toMatchObject({
    code: 'authentication_required',
    details: {
      authentication: {
        methods: [
          { id: 'cached_token', type: 'agent' },
          { id: 'terminal', type: 'terminal' },
        ],
      },
    },
  });
  expect(blocked.sent.map((message) => message.method)).toEqual([
    'initialize',
    'session/new',
  ]);
  const explicit = fixture({ init });
  await connectAcp(explicit.peer, '/workspace', undefined, {
    authMethodId: 'cached_token',
  });
  expect(explicit.sent.map((message) => message.method)).toEqual([
    'initialize',
    'authenticate',
    'session/new',
  ]);
  const terminal = fixture({ init });
  await expect(
    connectAcp(terminal.peer, '/workspace', undefined, {
      authMethodId: 'terminal',
    }),
  ).rejects.toMatchObject({ code: 'authentication_required' });
  expect(terminal.sent).toHaveLength(1);
});

it('projects grouped model/thinking/mode and boolean options, applies before admission and observes live command/config changes', async () => {
  let config = [
    select('model-choice', 'model', 'a', ['a', 'b']),
    select('effort', 'thought_level', 'low', ['low', 'high']),
    select('policy', 'mode', 'ask', ['ask', 'plan']),
    { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
  ];
  const f = fixture({
    opened: { sessionId: 'native-session', configOptions: config },
    handle: (message, reply) => {
      if (message.method !== 'session/set_config_option') return false;
      const params = record(message.params);
      config = config.map((option) =>
        option.id === params.configId
          ? ({ ...option, currentValue: params.value } as typeof option)
          : option,
      );
      reply(message, { configOptions: config });
      return true;
    },
  });
  const connection = await connectAcp(f.peer, '/workspace');
  expect(connection.capabilities.current).toEqual({
    model: 'a',
    thinking: 'low',
    mode: 'ask',
  });
  const order: string[] = [],
    target = sink();
  target.beforeDispatch = async () => {
    order.push('admitted');
    expect(
      f.sent.filter((m) => m.method === 'session/set_config_option'),
    ).toHaveLength(4);
  };
  const pending = connection.prompt(
    {
      text: 'Work',
      model: 'b',
      thinking: 'high',
      mode: 'plan',
      config: { fast: 'true' },
    },
    target,
  );
  await promptSent(f);
  expect(order).toEqual(['admitted']);
  expect(connection.capabilities.current).toEqual({
    model: 'b',
    thinking: 'high',
    mode: 'plan',
  });
  expect(
    f.sent.find((m) => record(m.params).configId === 'fast')?.params,
  ).toMatchObject({ value: true });
  const changed = vi.fn();
  connection.onCapabilities?.(changed);
  f.update({
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      {
        name: 'compact',
        description: 'Compact context',
        input: { hint: 'instructions' },
      },
    ],
  });
  f.update({
    sessionUpdate: 'config_option_update',
    configOptions: [select('model-choice', 'model', 'b', ['b'])],
  });
  expect(changed).toHaveBeenCalled();
  expect(connection.capabilities.commands).toEqual([
    {
      name: 'compact',
      description: 'Compact context',
      inputHint: 'instructions',
    },
  ]);
  expect(connection.capabilities.models.map((model) => model.id)).toEqual([
    'b',
  ]);
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
  await expect(
    connection.prompt({ text: 'Again', model: 'a' }, sink()),
  ).rejects.toThrow('requested value');
  expect(f.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
});

it('never records dispatch or sends a prompt after a setter refuses its value', async () => {
  const config = [select('model', 'model', 'a', ['a', 'b'])];
  const f = fixture({
    opened: { sessionId: 'native-session', configOptions: config },
    handle: (message, reply) => {
      if (message.method !== 'session/set_config_option') return false;
      reply(message, { configOptions: config });
      return true;
    },
  });
  const connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  target.beforeDispatch = vi.fn();
  await expect(
    connection.prompt({ text: 'Work', model: 'b' }, target),
  ).rejects.toThrow('did not apply');
  expect(target.beforeDispatch).not.toHaveBeenCalled();
  expect(f.latest('session/prompt')).toBeUndefined();
});

it('keeps pre-response commands but drops load history and other-session updates', async () => {
  const f = fixture({
    handle: (message, reply) => {
      if (message.method !== 'session/load') return false;
      f.update(
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'help', description: 'Help' }],
        },
        'saved',
      );
      f.update(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'old history' },
        },
        'saved',
      );
      reply(message, {});
      return true;
    },
  });
  const connection = await connectAcp(f.peer, '/workspace', 'saved'),
    target = sink();
  expect(connection.capabilities.commands?.[0]?.name).toBe('help');
  const pending = connection.prompt({ text: 'New' }, target);
  await promptSent(f);
  f.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'someone else' },
  });
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
  expect(target.item).not.toHaveBeenCalled();
});

it('withdraws permissions on protocol cancellation and waits for the actual prompt response after stop', async () => {
  const f = fixture(),
    connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  const signals: AbortSignal[] = [];
  target.interaction = vi.fn<HarnessSink['interaction']>((_request, signal) => {
    signals.push(signal!);
    return new Promise(() => {});
  });
  const pending = connection.prompt({ text: 'Work' }, target);
  let ended = false;
  void pending.then(() => {
    ended = true;
  });
  await promptSent(f);
  const permission = (id: string) =>
    f.emit({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native-session',
        toolCall: { toolCallId: id, title: 'Run command' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        ],
      },
    });
  permission('first');
  await vi.waitFor(() => expect(target.interaction).toHaveBeenCalledTimes(1));
  f.emit({
    jsonrpc: '2.0',
    method: '$/cancel_request',
    params: { requestId: 'first' },
  });
  await vi.waitFor(() =>
    expect(f.response('first')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    }),
  );
  expect(signals[0]?.aborted).toBe(true);
  permission('second');
  await vi.waitFor(() => expect(target.interaction).toHaveBeenCalledTimes(2));
  await connection.stop();
  await vi.waitFor(() =>
    expect(f.response('second')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    }),
  );
  expect(ended).toBe(false);
  expect(f.latest('session/cancel')).toBeDefined();
  await expect(
    connection.prompt({ text: 'Premature next' }, sink()),
  ).rejects.toThrow('already running');
  f.reply(f.latest('session/prompt'), { stopReason: 'cancelled' });
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
});

it('round-trips Qoder-style and OpenCode-style form questions with exact option values and validates answers', async () => {
  const f = fixture(),
    connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  target.interaction = vi.fn(async () => ({
    values: { q0: 'A', q1: ['x', 'y'], confirm: true, count: 2 },
  }));
  const pending = connection.prompt({ text: 'Ask' }, target);
  await promptSent(f);
  f.emit({
    jsonrpc: '2.0',
    id: 'form',
    method: 'elicitation/create',
    params: {
      mode: 'form',
      sessionId: 'native-session',
      message: 'Choose',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: {
            type: 'string',
            oneOf: [
              { const: 'A', title: 'Alpha' },
              { const: 'B', title: 'Beta' },
            ],
          },
          q1: {
            type: 'array',
            items: {
              type: 'string',
              anyOf: [
                { const: 'x', title: 'X' },
                { const: 'y', title: 'Y' },
              ],
            },
          },
          confirm: { type: 'boolean' },
          count: { type: 'integer', minimum: 1 },
        },
        required: ['q0', 'q1', 'confirm', 'count'],
      },
    },
  });
  await vi.waitFor(() =>
    expect(f.response('form')?.result).toEqual({
      action: 'accept',
      content: { q0: 'A', q1: ['x', 'y'], confirm: true, count: 2 },
    }),
  );
  expect(target.interaction.mock.calls[0]?.[0]).toMatchObject({
    fields: [
      { id: 'q0', type: 'select' },
      { id: 'q1', type: 'multiselect' },
      { id: 'confirm', type: 'boolean' },
      { id: 'count', type: 'number', integer: true, minimum: 1 },
    ],
  });
  f.emit({
    jsonrpc: '2.0',
    id: 'unsupported',
    method: 'elicitation/create',
    params: { mode: 'url', url: 'https://example.invalid/login' },
  });
  await vi.waitFor(() =>
    expect(f.response('unsupported')?.result).toEqual({ action: 'decline' }),
  );
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
});

it('retains text, embedded resources, image output and tool diffs without inventing billable usage semantics', async () => {
  const f = fixture(),
    connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  const pending = connection.prompt({ text: 'Show' }, target);
  await promptSent(f);
  f.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Result ' },
  });
  f.update({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'resource',
      resource: { uri: 'file:///workspace/result.txt', text: 'content' },
    },
  });
  f.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'edit',
    title: 'Edit file',
    rawInput: { path: '/workspace/a.ts' },
    status: 'in_progress',
  });
  f.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'edit',
    status: 'completed',
    content: [
      { type: 'diff', path: '/workspace/a.ts', oldText: 'old', newText: 'new' },
      {
        type: 'content',
        content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      },
    ],
  });
  f.update({ sessionUpdate: 'usage_update', used: 500, size: 1000 });
  expect(target.usage).not.toHaveBeenCalled();
  f.reply(f.latest('session/prompt'), {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedReadTokens: 30,
    },
  });
  await pending;
  expect(target.usage).not.toHaveBeenCalled();
  const items = target.item.mock.calls.map((call) => call[0] as ExternalItem);
  expect(
    items.some((item) =>
      item.text.includes('Result file:///workspace/result.txt\ncontent'),
    ),
  ).toBe(true);
  expect(
    items.find((item) => item.id === 'edit' && item.complete),
  ).toMatchObject({
    images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    tool: {
      path: '/workspace/a.ts',
      status: 'completed',
      output: '--- /workspace/a.ts\nold\n+++ /workspace/a.ts\nnew',
    },
  });
});

it('maps Grok legacy model/effort and native questions without pretending they are standard config options', async () => {
  const f = fixture({
    opened: {
      sessionId: 'native-session',
      models: {
        currentModelId: 'grok',
        availableModels: [
          {
            modelId: 'grok',
            name: 'Grok',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: ['low', 'high'],
              reasoningEffort: 'low',
            },
          },
        ],
      },
    },
    handle: (message, reply) => {
      if (message.method !== 'session/set_model') return false;
      reply(message, {});
      return true;
    },
  });
  const connection = await connectAcp(f.peer, '/workspace', undefined, {
      profile: getAcpProfile('grok'),
    }),
    target = sink();
  target.interaction = vi.fn(async () => ({ answers: { q0: ['A'] } }));
  const pending = connection.prompt({ text: 'Ask', thinking: 'high' }, target);
  await promptSent(f);
  expect(f.latest('session/set_model').params).toMatchObject({
    modelId: 'grok',
    _meta: { reasoningEffort: 'high' },
  });
  f.emit({
    jsonrpc: '2.0',
    id: 'grok-ask',
    method: '_x.ai/ask_user_question',
    params: {
      sessionId: 'native-session',
      toolCallId: 'ask',
      questions: [
        { question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    },
  });
  await vi.waitFor(() =>
    expect(f.response('grok-ask')?.result).toEqual({
      outcome: 'accepted',
      answers: { 'Pick?': 'A' },
      partial_answers: {},
    }),
  );
  target.interaction.mockResolvedValueOnce({
    answers: { q0: ['my own answer'] },
  });
  f.emit({
    jsonrpc: '2.0',
    id: 'grok-other',
    method: '_x.ai/ask_user_question',
    params: {
      sessionId: 'native-session',
      toolCallId: 'other',
      questions: [{ question: 'Pick?', options: [{ label: 'A' }] }],
    },
  });
  await vi.waitFor(() =>
    expect(f.response('grok-other')?.result).toEqual({
      outcome: 'accepted',
      answers: { 'Pick?': 'Other' },
      partial_answers: {},
      annotations: { 'Pick?': { notes: 'my own answer' } },
    }),
  );
  target.interaction.mockResolvedValueOnce({ cancelled: true });
  f.emit({
    jsonrpc: '2.0',
    id: 'grok-cancel',
    method: '_x.ai/ask_user_question',
    params: {
      sessionId: 'native-session',
      toolCallId: 'cancel',
      questions: [{ question: 'Pick?', options: [{ label: 'A' }] }],
    },
  });
  await vi.waitFor(() =>
    expect(f.response('grok-cancel')?.result).toEqual({
      outcome: 'skip_interview',
    }),
  );
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
});

it('revalidates dependent options after a model change instead of dispatching an obsolete value', async () => {
  const initial = [
    select('model', 'model', 'a', ['a', 'b']),
    select('thinking', 'thought_level', 'low', ['low', 'high']),
  ];
  const f = fixture({
    opened: { sessionId: 'native-session', configOptions: initial },
    handle: (message, reply) => {
      if (message.method !== 'session/set_config_option') return false;
      reply(message, {
        configOptions: [
          select('model', 'model', 'b', ['a', 'b']),
          select('thinking', 'thought_level', 'low', ['low']),
        ],
      });
      return true;
    },
  });
  const connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  target.beforeDispatch = vi.fn();
  await expect(
    connection.prompt({ text: 'Work', model: 'b', thinking: 'high' }, target),
  ).rejects.toThrow('requested value');
  expect(
    f.sent.filter((message) => message.method === 'session/set_config_option'),
  ).toHaveLength(1);
  expect(target.beforeDispatch).not.toHaveBeenCalled();
  expect(f.latest('session/prompt')).toBeUndefined();
  expect(connection.capabilities.current).toMatchObject({
    model: 'b',
    thinking: 'low',
  });
});

it('declines schema constraints it cannot faithfully render and invalid form answers', async () => {
  const f = fixture(),
    connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  target.interaction = vi.fn(async () => ({ values: { answer: 'unoffered' } }));
  const pending = connection.prompt({ text: 'Ask' }, target);
  await promptSent(f);
  const form = (id: string, property: unknown) =>
    f.emit({
      jsonrpc: '2.0',
      id,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { answer: property },
          required: ['answer'],
        },
      },
    });
  form('nested', {
    type: 'array',
    items: { type: 'string', enum: ['yes'], minLength: 5 },
  });
  form('union', { type: 'string', oneOf: [{ const: 'yes', pattern: '^no$' }] });
  form('bool-enum', { type: 'boolean', enum: [true] });
  await vi.waitFor(() =>
    expect(f.response('bool-enum')?.result).toEqual({ action: 'decline' }),
  );
  expect(f.response('nested')?.result).toEqual({ action: 'decline' });
  expect(f.response('union')?.result).toEqual({ action: 'decline' });
  expect(target.interaction).not.toHaveBeenCalled();
  form('invalid-answer', { type: 'string', enum: ['yes', 'no'] });
  await vi.waitFor(() =>
    expect(f.response('invalid-answer')?.result).toEqual({ action: 'decline' }),
  );
  expect(target.interaction).toHaveBeenCalledTimes(1);
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
});

it('does not adopt connection-level Grok catalog defaults as session state', async () => {
  const model = (id: string) => ({
    modelId: id,
    name: id,
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: [{ id: 'deep', value: 'high' }],
      reasoningEffort: 'high',
    },
  });
  const f = fixture({
    init: {
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: {
        modelState: {
          currentModelId: 'global',
          availableModels: [model('global'), model('session')],
        },
      },
    },
    opened: {
      sessionId: 'native-session',
      _meta: {
        'x.ai/sessionConfig': {
          options: [
            { id: 'global', category: 'model', label: 'Global' },
            {
              id: 'session',
              category: 'model',
              label: 'Session',
              selected: true,
            },
            { id: 'deep', category: 'mode', selected: true },
          ],
        },
      },
    },
  });
  const connection = await connectAcp(f.peer, '/workspace', undefined, {
    profile: getAcpProfile('grok'),
  });
  expect(connection.capabilities.current).toEqual({
    model: 'session',
    thinking: 'deep',
  });
  expect(connection.capabilities.models[0]?.thinkingLevels).toEqual(['deep']);
  f.emit({
    jsonrpc: '2.0',
    method: '_x.ai/models/update',
    params: {
      currentModelId: 'global',
      availableModels: [model('global'), model('session'), model('new')],
    },
  });
  expect(connection.capabilities.models.map((model) => model.id)).toEqual([
    'global',
    'session',
    'new',
  ]);
  expect(connection.capabilities.current).toEqual({
    model: 'session',
    thinking: 'deep',
  });
});

it('keeps stop intent distinct when the agent completes before cancellation takes effect', async () => {
  const f = fixture(),
    connection = await connectAcp(f.peer, '/workspace');
  const pending = connection.prompt({ text: 'Work' }, sink());
  await promptSent(f);
  await connection.stop();
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await expect(pending).resolves.toEqual({ status: 'completed' });
});

it('replaces tool content on updates while preserving fields omitted from partial updates', async () => {
  const f = fixture(),
    connection = await connectAcp(f.peer, '/workspace'),
    target = sink();
  const pending = connection.prompt({ text: 'Work' }, target);
  await promptSent(f);
  f.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool',
    title: 'Inspect',
    rawInput: { path: '/workspace/a' },
    content: [
      {
        type: 'content',
        content: { type: 'image', data: 'eA==', mimeType: 'image/png' },
      },
    ],
  });
  f.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool',
    content: [{ type: 'content', content: { type: 'text', text: 'revised' } }],
    status: 'completed',
  });
  const item = target.item.mock.calls.at(-1)?.[0];
  expect(item?.images).toBeUndefined();
  expect(item?.tool).toMatchObject({
    name: 'Inspect',
    input: { path: '/workspace/a' },
    output: 'revised',
    status: 'completed',
  });
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
});

it('discovers target-model thinking options before validating the combined selection', async () => {
  let config = [
    select('model', 'model', 'a', ['a', 'b']),
    select('effort-a', 'thought_level', 'low', ['low']),
  ];
  const f = fixture({
    opened: { sessionId: 'native-session', configOptions: config },
    handle: (message, reply) => {
      if (message.method !== 'session/set_config_option') return false;
      const params = record(message.params);
      if (params.configId === 'model')
        config = [
          select('model', 'model', 'b', ['a', 'b']),
          select('effort-b', 'thought_level', 'medium', ['medium', 'high']),
        ];
      else
        config = config.map((option) =>
          option.id === params.configId
            ? { ...option, currentValue: String(params.value) }
            : option,
        );
      reply(message, { configOptions: config });
      return true;
    },
  });
  const connection = await connectAcp(f.peer, '/workspace');
  expect(
    connection.capabilities.models.find((model) => model.id === 'a')
      ?.thinkingLevels,
  ).toEqual(['low']);
  expect(
    connection.capabilities.models.find((model) => model.id === 'b')
      ?.thinkingLevels,
  ).toBeUndefined();
  const pending = connection.prompt(
    { text: 'Work', model: 'b', thinking: 'high' },
    sink(),
  );
  await promptSent(f);
  expect(
    f.sent
      .filter((message) => message.method === 'session/set_config_option')
      .map((message) => record(message.params).configId),
  ).toEqual(['model', 'effort-b']);
  expect(connection.capabilities.current).toMatchObject({
    model: 'b',
    thinking: 'high',
  });
  expect(
    connection.capabilities.models.find((model) => model.id === 'a')
      ?.thinkingLevels,
  ).toBeUndefined();
  expect(
    connection.capabilities.models.find((model) => model.id === 'b')
      ?.thinkingLevels,
  ).toEqual(['medium', 'high']);
  f.reply(f.latest('session/prompt'), { stopReason: 'end_turn' });
  await pending;
});
