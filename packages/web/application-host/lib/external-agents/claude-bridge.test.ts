import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { query as installedQuery } from '@anthropic-ai/claude-agent-sdk/core';
import { expect, it, vi } from 'vitest';
import type { query, Query, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core';
import { ClaudeBridge } from './claude-bridge.js';
import { record, type RecordValue } from './transport.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
function fixture() {
  let wake: (() => void) | undefined,
    failure: Error | undefined,
    ended = false;
  const queue: RecordValue[] = [],
    frames: RecordValue[] = [];
  let options!: Options, input!: AsyncIterable<SDKUserMessage>;
  const sdk = {
    initializationResult: vi.fn(async () => ({
      models: [{ value: 'sonnet', displayName: 'Sonnet' }],
      commands: [{ name: 'review', description: 'Review' }],
      claude_code_version: '2.1.316',
    })),
    setModel: vi.fn(async (_model: string) => {}),
    applyFlagSettings: vi.fn(async (_flags: unknown) => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(() => {
      ended = true;
      wake?.();
    }),
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (!queue.length && !failure)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (failure) throw failure;
        while (queue.length) yield queue.shift()!;
      }
    },
  };
  const factory = vi.fn((args: Parameters<typeof query>[0]) => {
    options = args.options!;
    input = args.prompt as AsyncIterable<SDKUserMessage>;
    return sdk as unknown as Query;
  });
  const fatal = vi.fn<(error: Error) => void>();
  const bridge = new ClaudeBridge(factory, (frame) => frames.push(record(frame)), fatal);
  const emit = async (frame: RecordValue) => {
    queue.push({ session_id: sessionId, ...frame });
    wake?.();
    await vi.waitFor(() => expect(queue).toHaveLength(0));
  };
  const initialize = () =>
    bridge.handle({
      method: 'initialize',
      params: {
        cwd: '/workspace',
        sessionId,
        launcher: { command: 'not-executed', args: ['entry.js', '--flag'] },
      },
    });
  return {
    bridge,
    sdk,
    fatal,
    frames,
    initialize,
    emit,
    get options() {
      return options;
    },
    get input() {
      return input;
    },
    die(error: Error) {
      failure = error;
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

it('restores exactly the requested SDK session and configures before enqueuing UUID-stamped input', async () => {
  const f = fixture();
  await expect(f.initialize()).resolves.toMatchObject({
    bridgeProtocol: 2,
    sessionId,
    agentVersion: '2.1.316',
  });
  expect(f.options.resume).toBe(sessionId);
  expect(f.options.sessionId).toBeUndefined();
  await f.bridge.handle({ method: 'configure', params: { model: 'sonnet', thinking: 'high' } });
  expect(f.sdk.setModel).toHaveBeenCalledWith('sonnet');
  expect(f.sdk.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' });
  await expect(
    f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'hello' } }),
  ).resolves.toMatchObject({ accepted: true, turnId: first });
  const user = await f.input[Symbol.asyncIterator]().next();
  expect(user.value).toMatchObject({
    type: 'user',
    uuid: first,
    session_id: sessionId,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
  f.bridge.close();
});

it('refuses unsupported controls before touching native settings and does not fabricate effective effort', async () => {
  const f = fixture();
  await f.initialize();
  await expect(
    f.bridge.handle({ method: 'configure', params: { model: 'sonnet', thinking: 'impossible' } }),
  ).rejects.toThrow('effort');
  await expect(
    f.bridge.handle({
      method: 'configure',
      params: { model: 'sonnet', config: { custom: 'value' } },
    }),
  ).rejects.toThrow('controls');
  expect(f.sdk.setModel).not.toHaveBeenCalled();
  await f.emit({
    type: 'system',
    subtype: 'init',
    model: 'canonical-model',
    claude_code_version: '2.1.316',
  });
  await expect(
    f.bridge.handle({ method: 'configure', params: { thinking: 'max' } }),
  ).resolves.toEqual({ current: { model: 'canonical-model' } });
  await expect(
    f.bridge.handle({ method: 'configure', params: { model: 'other-alias' } }),
  ).resolves.toEqual({ current: {} });
  f.bridge.close();
});

it('labels SDK messages with their active admission and excludes late results carrying another native user UUID', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'first' } });
  await f.emit({
    type: 'assistant',
    user_message_uuid: first,
    message: { id: 'native', content: [{ type: 'text', text: 'one' }] },
  });
  await f.emit({ type: 'result', user_message_uuid: first, is_error: false });
  await f.bridge.handle({ method: 'prompt', params: { uuid: second, text: 'second' } });
  const count = f.frames.length;
  await f.emit({ type: 'result', user_message_uuid: first, is_error: false });
  expect(f.frames).toHaveLength(count);
  await f.emit({ type: 'result', user_message_uuid: second, is_error: false });
  expect(
    f.frames
      .filter((frame) => frame.method === 'message')
      .map((frame) => record(frame.params).turnId),
  ).toEqual([first, first, second]);
  f.bridge.close();
});

it('withdraws native permissions and resolves them before native interrupt waits', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'tools' } });
  await f.input[Symbol.asyncIterator]().next();
  await f.emit({
    type: 'assistant',
    user_message_uuid: first,
    message: {
      id: 'native',
      content: [
        { type: 'tool_use', id: 'tool', name: 'Bash' },
        { type: 'tool_use', id: 'other', name: 'Bash' },
      ],
    },
  });
  const controller = new AbortController();
  const answer = f.options.canUseTool!(
    'Bash',
    { command: 'unused' },
    { signal: controller.signal, toolUseID: 'tool', requestId: 'request-1', suggestions: [] },
  );
  await vi.waitFor(() =>
    expect(f.frames.some((frame) => frame.method === 'permission')).toBe(true),
  );
  controller.abort();
  await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
  expect(f.frames.some((frame) => frame.method === 'permission_cancelled')).toBe(true);
  const pending = f.options.canUseTool!(
    'Bash',
    {},
    {
      signal: new AbortController().signal,
      toolUseID: 'other',
      requestId: 'request-2',
      suggestions: [],
    },
  );
  f.sdk.interrupt.mockImplementationOnce(async () => {
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });
  await f.bridge.handle({ method: 'interrupt' });
  expect(f.frames.some((frame) => record(record(frame.params).message).type === 'result')).toBe(
    false,
  );
  f.bridge.close();
});

it('treats iterator failure as session fatal, closes the query and refuses stale reuse', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'first' } });
  f.die(new Error('query died'));
  await vi.waitFor(() => expect(f.fatal).toHaveBeenCalledOnce());
  expect(f.sdk.close).toHaveBeenCalledOnce();
  expect(f.frames.find((frame) => frame.method === 'failure')).toMatchObject({
    params: { message: 'query died' },
  });
  await expect(
    f.bridge.handle({ method: 'prompt', params: { uuid: second, text: 'unsafe' } }),
  ).rejects.toThrow('query died');
});

it('also treats unexpected normal SDK iterator exhaustion and changed native session identity as fatal', async () => {
  const f = fixture();
  await f.initialize();
  f.end();
  await vi.waitFor(() => expect(f.fatal).toHaveBeenCalledOnce());
  const changed = fixture();
  await changed.initialize();
  await changed.emit({ type: 'system', session_id: 'different', subtype: 'init', model: 'model' });
  await vi.waitFor(() =>
    expect(changed.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('identity') }),
    ),
  );
});

it('withdraws locally queued input with an explicit bridge receipt rather than inventing a native result', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'not consumed' } });
  await expect(f.bridge.handle({ method: 'interrupt' })).resolves.toEqual({
    cancelledBeforeNativeDelivery: true,
  });
  expect(f.sdk.interrupt).not.toHaveBeenCalled();
  expect(f.frames.find((frame) => frame.method === 'admission_cancelled')).toMatchObject({
    params: { sessionId, turnId: first },
  });
  expect(f.frames.some((frame) => frame.method === 'message')).toBe(false);
  f.bridge.close();
});

it('ignores the untagged tail of a foreign SDK turn until a new current-input stamp restores ownership', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: second, text: 'new input' } });
  await f.emit({
    type: 'assistant',
    user_message_uuid: first,
    message: { id: 'old-native', content: [{ type: 'text', text: 'old first block' }] },
  });
  await f.emit({
    type: 'assistant',
    message: { id: 'old-native', content: [{ type: 'text', text: 'old untagged tail' }] },
  });
  await f.emit({ type: 'result', is_error: false });
  expect(f.frames.some((frame) => frame.method === 'message')).toBe(false);
  await f.emit({ type: 'result', user_message_uuid: second, is_error: false });
  expect(f.frames.filter((frame) => frame.method === 'message')).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ turnId: second }) }),
  ]);
  f.bridge.close();
});

it('denies a resumed old-turn permission with a visible compatibility diagnosis instead of asking the current user to authorize old work', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: second, text: 'new input' } });
  const answer = f.options.canUseTool!(
    'Bash',
    { command: 'old work' },
    { signal: new AbortController().signal, toolUseID: 'old-tool', requestId: 'old-request' },
  );
  await f.emit({
    type: 'assistant',
    user_message_uuid: first,
    message: { id: 'old-native', content: [{ type: 'tool_use', id: 'old-tool', name: 'Bash' }] },
  });
  await expect(answer).resolves.toMatchObject({
    behavior: 'deny',
    message: expect.stringContaining('not by the user'),
  });
  expect(f.frames.some((frame) => frame.method === 'permission')).toBe(false);
  expect(
    f.frames.find(
      (frame) =>
        frame.method === 'notice' &&
        String(record(frame.params).message).includes('Cannot correlate'),
    ),
  ).toMatchObject({
    params: { turnId: second, message: expect.stringContaining('Update the Claude Code CLI') },
  });
  f.bridge.close();
});

it('waits for exact native evidence when the permission callback precedes every streamed frame', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'new input' } });
  await f.input[Symbol.asyncIterator]().next();
  const answer = f.options.canUseTool!(
    'Bash',
    {},
    { signal: new AbortController().signal, toolUseID: 'late-tool', requestId: 'late-request' },
  );
  expect(f.frames.some((frame) => frame.method === 'permission')).toBe(false);
  expect(f.frames.find((frame) => frame.method === 'notice')).toMatchObject({
    params: { message: expect.stringContaining('Waiting to correlate') },
  });
  await f.emit({
    type: 'stream_event',
    user_message_uuid: first,
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'native' } },
  });
  expect(f.frames.some((frame) => frame.method === 'permission')).toBe(false);
  await f.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'late-tool', name: 'Bash' },
    },
  });
  await vi.waitFor(() =>
    expect(f.frames.some((frame) => frame.method === 'permission')).toBe(true),
  );
  const request = f.frames.find((frame) => frame.method === 'permission')!;
  f.bridge.respond({ id: request.id, result: { behavior: 'allow', updatedInput: {} } });
  await expect(answer).resolves.toMatchObject({ behavior: 'allow' });
  f.bridge.close();
});

it('withdraws unmatched correlation before waiting for native interrupt, including unknown-UUID producers', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'new input' } });
  await f.input[Symbol.asyncIterator]().next();
  const answer = f.options.canUseTool!(
    'Bash',
    {},
    { signal: new AbortController().signal, toolUseID: 'unknown', requestId: 'unknown-request' },
  );
  await f.emit({
    type: 'assistant',
    message: { id: 'unproven', content: [{ type: 'tool_use', id: 'unknown', name: 'Bash' }] },
  });
  expect(f.frames.some((frame) => frame.method === 'permission')).toBe(false);
  f.sdk.interrupt.mockImplementationOnce(async () => {
    await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
  });
  await f.bridge.handle({ method: 'interrupt' });
  expect(f.frames.some((frame) => frame.method === 'permission')).toBe(false);
  f.bridge.close();
});

it('never carries a pending correlation into a successor admission after terminal or fatal native events', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: first, text: 'first' } });
  const answer = f.options.canUseTool!(
    'Bash',
    {},
    { signal: new AbortController().signal, toolUseID: 'tool', requestId: 'request' },
  );
  await f.emit({ type: 'result', user_message_uuid: first, is_error: false });
  await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
  await f.bridge.handle({ method: 'prompt', params: { uuid: second, text: 'second' } });
  await f.emit({
    type: 'assistant',
    user_message_uuid: second,
    message: { id: 'next', content: [{ type: 'tool_use', id: 'tool', name: 'Bash' }] },
  });
  expect(f.frames.some((frame) => frame.method === 'permission')).toBe(false);
  const pending = f.options.canUseTool!(
    'Bash',
    {},
    { signal: new AbortController().signal, toolUseID: 'missing', requestId: 'fatal-request' },
  );
  f.die(new Error('query died'));
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  await vi.waitFor(() => expect(f.fatal).toHaveBeenCalledOnce());
});

it('does not attribute unproven native content or a result to the current admission', async () => {
  const f = fixture();
  await f.initialize();
  await f.bridge.handle({ method: 'prompt', params: { uuid: second, text: 'new input' } });
  await f.emit({
    type: 'assistant',
    message: { id: 'unproven', content: [{ type: 'text', text: 'unknown owner' }] },
  });
  await f.emit({ type: 'result', is_error: false });
  expect(f.frames.some((frame) => frame.method === 'message')).toBe(false);
  expect(f.frames.find((frame) => frame.method === 'notice')).toMatchObject({
    params: {
      message: expect.stringContaining('Uncorrelated output and completion are not assigned'),
    },
  });
  await f.emit({ type: 'result', user_message_uuid: second, is_error: false });
  expect(f.frames.filter((frame) => frame.method === 'message')).toHaveLength(1);
  f.bridge.close();
});

it('correlates coalesced native tool/control frames through the real pinned SDK even when its consumer has not projected any event', async () => {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    child = new EventEmitter();
  const nativeInput: RecordValue[] = [],
    bridgeFrames: RecordValue[] = [];
  let releaseProjection!: () => void;
  const projection = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  let callbackStarted = false,
    projectedWhenCallbackStarted = -1;
  let stdinBuffer = '';
  const send = (...frames: RecordValue[]) =>
    stdout.write(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
  const finishChild = () => {
    if (processChild.exitCode !== null) return;
    processChild.exitCode = 0;
    stdout.end();
    stderr.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  };
  const processChild = Object.assign(child, {
    stdin: new Writable({
      write(data, _encoding, done) {
        stdinBuffer += String(data);
        for (;;) {
          const index = stdinBuffer.indexOf('\n');
          if (index < 0) break;
          const line = stdinBuffer.slice(0, index);
          stdinBuffer = stdinBuffer.slice(index + 1);
          if (!line.trim()) continue;
          const message = record(JSON.parse(line));
          nativeInput.push(message);
          if (
            message.type === 'control_request' &&
            record(message.request).subtype === 'initialize'
          )
            send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: {
                  commands: [],
                  agents: [],
                  models: [],
                  account: {},
                  output_style: 'default',
                  available_output_styles: [],
                  claude_code_version: '2.1.316',
                },
              },
            });
        }
        done();
      },
      final(done) {
        finishChild();
        done();
      },
    }),
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    kill() {
      processChild.killed = true;
      finishChild();
      return true;
    },
  });
  const factory: typeof query = (args) => {
    const original = args.options!.canUseTool!;
    const sdk = installedQuery({
      ...args,
      options: {
        ...args.options,
        spawnClaudeCodeProcess: () =>
          processChild as unknown as ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>>,
        canUseTool: (name, input, options) => {
          callbackStarted = true;
          projectedWhenCallbackStarted = bridgeFrames.filter(
            (frame) => frame.method === 'message',
          ).length;
          return original(name, input, options);
        },
      },
    });
    // Slow consumers are allowed by the public iterator contract. SDK controls
    // keep flowing independently while the native event is already queued.
    return new Proxy(sdk, {
      get(target, key) {
        if (key === Symbol.asyncIterator)
          return async function* () {
            await projection;
            yield* target;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const fatal = vi.fn<(error: Error) => void>();
  const bridge = new ClaudeBridge(factory, (frame) => bridgeFrames.push(record(frame)), fatal);
  try {
    await bridge.handle({
      method: 'initialize',
      params: { cwd: '/workspace', sessionId, launcher: { command: 'not-executed', args: [] } },
    });
    await bridge.handle({ method: 'prompt', params: { uuid: first, text: 'in-memory only' } });
    await vi.waitFor(() => expect(nativeInput.some((frame) => frame.type === 'user')).toBe(true));
    send(
      {
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: second,
        user_message_uuid: first,
        message: {
          id: 'native-message',
          content: [{ type: 'tool_use', id: 'real-sdk-tool', name: 'Bash', input: {} }],
        },
      },
      {
        type: 'control_request',
        request_id: 'real-sdk-request',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'real-sdk-tool',
          input: {},
        },
      },
    );
    await vi.waitFor(() => expect(callbackStarted).toBe(true));
    expect(projectedWhenCallbackStarted).toBe(0);
    expect(bridgeFrames.some((frame) => frame.method === 'permission')).toBe(false);
    releaseProjection();
    await vi.waitFor(() =>
      expect(bridgeFrames.some((frame) => frame.method === 'permission')).toBe(true),
    );
    const permission = bridgeFrames.find((frame) => frame.method === 'permission')!;
    bridge.respond({ id: permission.id, result: { behavior: 'allow', updatedInput: {} } });
    await vi.waitFor(() =>
      expect(
        nativeInput.find(
          (frame) =>
            frame.type === 'control_response' &&
            record(frame.response).request_id === 'real-sdk-request',
        ),
      ).toMatchObject({ response: { subtype: 'success', response: { behavior: 'allow' } } }),
    );
    expect(fatal).not.toHaveBeenCalled();
  } finally {
    releaseProjection();
    bridge.close();
    finishChild();
  }
});

it('bridges session background levels without an active turn and queries only native context summary', async () => {
  const f = fixture();
  const getContextUsage = vi.fn(async () => ({ totalTokens: 123, rawMaxTokens: 1000 }));
  Object.assign(f.sdk, { getContextUsage });
  await f.initialize();
  await expect(f.bridge.handle({ method: 'context_usage' })).resolves.toEqual({ sessionId, used: 123, size: 1000 });
  expect(getContextUsage).toHaveBeenCalledWith({ detail: 'summary' });
  await f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'background' }] });
  expect(f.frames).toContainEqual(expect.objectContaining({ method: 'activity', params: expect.objectContaining({ sessionId,
    message: expect.objectContaining({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'background' }] }),
  }) }));
  expect(f.frames.filter(frame => frame.method === 'message')).toHaveLength(0);
  f.bridge.close();
});
