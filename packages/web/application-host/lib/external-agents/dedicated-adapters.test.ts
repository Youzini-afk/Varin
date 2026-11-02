import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalInteractionResponse, ExternalItem } from '@varin/application-client';
import type { KernelManagedProcess } from '../kernel/process-service.js';
import type { HarnessSink } from './adapter.js';
import { connectCodex } from './codex.js';
import { connectClaude } from './claude.js';
import { connectPi } from './pi.js';
import { requirePiRpcVersion } from './pi-version.js';
import { HarnessProtocolError, HarnessTransport, record, type RecordValue } from './transport.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
/** Real transport, byte streams and request IDs; the peer is only a protocol fixture. */
class Peer {
  readonly frames: RecordValue[] = [];
  readonly stdout = new PassThrough();
  readonly child = new EventEmitter();
  readonly transport: HarnessTransport;
  handler: (method: string, params: RecordValue) => Promise<RecordValue> | RecordValue;
  private readonly waits: Array<() => void> = [];
  constructor(kind: 'rpc' | 'pi' = 'rpc') {
    this.handler = (method, params) => {
      if (method === 'initialize')
        return { sessionId: 'claude-session', bridgeProtocol: 2, models: [] };
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'thread' } };
      if (method === 'model/list') return { data: [] };
      if (method === 'get_state')
        return {
          sessionFile: '/pi/session.jsonl',
          sessionId: 'pi-session',
          model: { provider: 'provider', id: 'model' },
          thinkingLevel: 'low',
        };
      if (method === 'get_available_models')
        return { models: [{ provider: 'provider', id: 'model', name: 'Model' }] };
      if (method === 'get_available_thinking_levels') return { levels: ['off', 'low', 'high'] };
      if (method === 'prompt')
        return kind === 'pi' ? { disposition: 'started' } : { accepted: true, turnId: params.uuid };
      return {};
    };
    Object.assign(this.child, {
      stdout: this.stdout,
      stderr: new PassThrough(),
      stdin: new Writable({
        write: (data, _encoding, callback) => {
          const frame = record(JSON.parse(String(data)));
          this.frames.push(frame);
          for (const wake of this.waits.splice(0)) wake();
          callback();
          const method = kind === 'pi' ? String(frame.type) : String(frame.method ?? '');
          if (!frame.id || (kind === 'rpc' && !frame.method) || method === 'extension_ui_response')
            return;
          void Promise.resolve()
            .then(() => this.handler(method, kind === 'pi' ? frame : record(frame.params)))
            .then(
              (result) =>
                this.emit(
                  kind === 'pi'
                    ? {
                        type: 'response',
                        id: frame.id,
                        command: method,
                        success: true,
                        data: result,
                      }
                    : { jsonrpc: '2.0', id: frame.id, result },
                ),
              (error) =>
                this.emit(
                  kind === 'pi'
                    ? {
                        type: 'response',
                        id: frame.id,
                        command: method,
                        success: false,
                        error: String(error.message),
                      }
                    : {
                        jsonrpc: '2.0',
                        id: frame.id,
                        error: { code: -32000, message: String(error.message) },
                      },
                ),
            );
        },
      }),
      completion: new Promise(() => {}),
      release: async () => {},
      discardOutput: () => {},
      requestTermination: async () => {},
    });
    this.transport = new HarnessTransport(this.child as KernelManagedProcess, kind);
  }
  emit(value: RecordValue) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  event(method: string, params: RecordValue) {
    this.emit({ jsonrpc: '2.0', method, params });
  }
  async frame(predicate: (frame: RecordValue) => boolean): Promise<RecordValue> {
    for (;;) {
      const frame = this.frames.find(predicate);
      if (frame) return frame;
      await new Promise<void>((resolve) => this.waits.push(resolve));
    }
  }
  call(method: string) {
    return this.frame((frame) => frame.method === method || frame.type === method);
  }
  reply(id: string) {
    return this.frame((frame) => frame.id === id && ('result' in frame || 'error' in frame));
  }
}
function sink() {
  const items = new Map<string, Omit<ExternalItem, 'turnId'>>();
  return {
    items,
    item: vi.fn<HarnessSink['item']>((item) => items.set(item.id, item)),
    usage: vi.fn<HarnessSink['usage']>(),
    interaction: vi.fn<HarnessSink['interaction']>(async () => ({ optionId: 'accept' })),
    beforeDispatch: vi.fn(async () => {}),
    started: vi.fn<(id: string) => void>(),
  };
}
const codexEvent = (turnId: string, extra: RecordValue = {}) => ({
  threadId: 'thread',
  turnId,
  ...extra,
});
function claudeEvent(peer: Peer, turnId: string, message: RecordValue) {
  peer.event('message', {
    sessionId: 'claude-session',
    turnId,
    message: { session_id: 'claude-session', ...message },
  });
}
const pi = (peer: Peer, existing?: string) =>
  connectPi(peer.transport, existing, { version: 'pi 1.5.0' });

function cancellableInteraction(
  _request: Parameters<HarnessSink['interaction']>[0],
  signal?: AbortSignal,
) {
  return new Promise<ExternalInteractionResponse>((resolve) => {
    if (signal?.aborted) resolve({ cancelled: true });
    else signal?.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
  });
}

describe('Codex native turn ownership', () => {
  it('buffers the pre-start window but accepts completion/items/approval only for the response-owned turn', async () => {
    const peer = new Peer(),
      start = deferred<RecordValue>(),
      s = sink();
    const fallback = peer.handler;
    peer.handler = (method, params) =>
      method === 'turn/start' ? start.promise : fallback(method, params);
    const connection = await connectCodex(peer.transport, '/workspace');
    const result = connection.prompt({ text: 'new' }, s);
    await peer.call('turn/start');
    peer.event('turn/completed', codexEvent('old', { turn: { id: 'old', status: 'completed' } }));
    peer.emit({
      id: 'old-permission',
      method: 'item/commandExecution/requestApproval',
      params: codexEvent('old', { availableDecisions: ['accept', 'cancel'] }),
    });
    peer.event('item/agentMessage/delta', codexEvent('new', { itemId: 'answer', delta: 'right' }));
    start.resolve({ turn: { id: 'new' } });
    await expect(peer.reply('old-permission')).resolves.toHaveProperty('error');
    expect(s.interaction).not.toHaveBeenCalled();
    expect(s.items.get('answer')?.text).toBe('right');
    let done = false;
    void result.then(() => {
      done = true;
    });
    peer.event('turn/completed', codexEvent('new', { turn: { id: 'wrong', status: 'completed' } }));
    await Promise.resolve();
    expect(done).toBe(false);
    peer.event('turn/completed', { threadId: 'thread', turn: { id: 'new', status: 'completed' } });
    await expect(result).resolves.toMatchObject({ status: 'completed', nativeId: 'new' });
    expect(s.beforeDispatch).toHaveBeenCalledOnce();
  });
  it('cancels outstanding native approvals before waiting for interrupt and preserves failed outcomes', async () => {
    const peer = new Peer(),
      s = sink();
    s.interaction = vi.fn(cancellableInteraction);
    const fallback = peer.handler;
    peer.handler = (method, params) =>
      method === 'turn/start' ? { turn: { id: 'new' } } : fallback(method, params);
    const connection = await connectCodex(peer.transport, '/workspace'),
      result = connection.prompt({ text: 'new' }, s);
    await peer.call('turn/start');
    await vi.waitFor(() => expect(s.started).toHaveBeenCalled());
    peer.emit({
      id: 'permission',
      method: 'item/commandExecution/requestApproval',
      params: codexEvent('new'),
    });
    await vi.waitFor(() => expect(s.interaction).toHaveBeenCalledOnce());
    await connection.stop();
    await expect(peer.reply('permission')).resolves.toHaveProperty('result.decision', 'cancel');
    peer.event(
      'turn/completed',
      codexEvent('new', {
        turn: { id: 'new', status: 'failed', error: { message: 'native failure' } },
      }),
    );
    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'native failure' });
  });
  it('paginates the native model catalog and diagnoses cyclic pages without inventing an empty catalog', async () => {
    const peer = new Peer(),
      fallback = peer.handler;
    peer.handler = (method, params) =>
      method === 'model/list'
        ? params.cursor
          ? { data: [{ id: 'second', model: 'second' }], nextCursor: null }
          : { data: [{ id: 'first', model: 'first' }], nextCursor: 'page-2' }
        : fallback(method, params);
    const connection = await connectCodex(peer.transport, '/workspace');
    expect(connection.capabilities.models.map((model) => model.id)).toEqual(['first', 'second']);
    expect(
      peer.frames.filter((frame) => frame.method === 'model/list').map((frame) => frame.params),
    ).toEqual([{}, { cursor: 'page-2' }]);
    const cyclic = new Peer(),
      original = cyclic.handler;
    cyclic.handler = (method, params) =>
      method === 'model/list'
        ? { data: [{ id: 'one' }], nextCursor: 'same' }
        : original(method, params);
    const incomplete = await connectCodex(cyclic.transport, '/workspace');
    expect(incomplete.capabilities.modelsError).toContain('repeated');
    expect(incomplete.capabilities.models[0]?.id).toBe('one');
  });
  it('grants only the displayed requested permission overlay for the active turn, and withdraws native requests', async () => {
    const peer = new Peer(),
      fallback = peer.handler,
      s = sink();
    peer.handler = (method, params) =>
      method === 'turn/start' ? { turn: { id: 'turn' } } : fallback(method, params);
    const connection = await connectCodex(peer.transport, '/workspace'),
      result = connection.prompt({ text: 'request' }, s);
    await vi.waitFor(() => expect(s.started).toHaveBeenCalled());
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ['/read'], write: ['/write'] },
    };
    s.interaction = vi.fn(async () => ({ optionId: 'grant' }));
    peer.emit({
      id: 'permission-overlay',
      method: 'item/permissions/requestApproval',
      params: codexEvent('turn', { permissions }),
    });
    await expect(peer.reply('permission-overlay')).resolves.toHaveProperty('result', {
      permissions,
      scope: 'turn',
      strictAutoReview: true,
    });
    expect(s.interaction.mock.calls[0]?.[0].detail).toContain('/write');
    s.interaction = vi.fn(cancellableInteraction);
    peer.emit({
      id: 'withdrawn',
      method: 'item/permissions/requestApproval',
      params: codexEvent('turn', { permissions }),
    });
    await vi.waitFor(() => expect(s.interaction).toHaveBeenCalledOnce());
    peer.event('serverRequest/resolved', { threadId: 'thread', requestId: 'withdrawn' });
    await expect(peer.reply('withdrawn')).resolves.toHaveProperty('result.permissions', {});
    peer.event('turn/completed', codexEvent('turn', { turn: { id: 'turn', status: 'completed' } }));
    await result;
  });
  it('returns typed MCP form replies only for the active native turn and declines unsupported URL/schema requests', async () => {
    const peer = new Peer(),
      fallback = peer.handler,
      s = sink();
    peer.handler = (method, params) =>
      method === 'turn/start' ? { turn: { id: 'turn' } } : fallback(method, params);
    const connection = await connectCodex(peer.transport, '/workspace'),
      result = connection.prompt({ text: 'form' }, s);
    await vi.waitFor(() => expect(s.started).toHaveBeenCalled());
    s.interaction = vi.fn(async () => ({ values: { confirm: true, count: 2 } }));
    const params = {
      serverName: 'MCP server',
      mode: 'form',
      message: 'Confirm',
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean' }, count: { type: 'integer', minimum: 1 } },
        required: ['confirm'],
      },
    };
    peer.emit({
      id: 'form',
      method: 'mcpServer/elicitation/request',
      params: codexEvent('turn', params),
    });
    await expect(peer.reply('form')).resolves.toHaveProperty('result', {
      action: 'accept',
      content: { confirm: true, count: 2 },
      _meta: null,
    });
    peer.emit({
      id: 'url',
      method: 'mcpServer/elicitation/request',
      params: codexEvent('turn', {
        ...params,
        mode: 'url',
        url: 'https://example.invalid/not-opened',
      }),
    });
    await expect(peer.reply('url')).resolves.toHaveProperty('result', {
      action: 'decline',
      content: null,
      _meta: null,
    });
    peer.emit({
      id: 'old-form',
      method: 'mcpServer/elicitation/request',
      params: codexEvent('old', params),
    });
    await expect(peer.reply('old-form')).resolves.toHaveProperty('result.action', 'cancel');
    expect(s.interaction).toHaveBeenCalledOnce();
    peer.event('turn/completed', codexEvent('turn', { turn: { id: 'turn', status: 'completed' } }));
    await result;
  });
  it('does not present requested model aliases or effort as observed effective controls merely because the turn was accepted', async () => {
    const peer = new Peer(),
      fallback = peer.handler,
      s = sink();
    peer.handler = (method, params) =>
      method === 'thread/start'
        ? { thread: { id: 'thread' }, model: 'native-model', reasoningEffort: 'low' }
        : method === 'turn/start'
          ? { turn: { id: 'turn' } }
          : fallback(method, params);
    const connection = await connectCodex(peer.transport, '/workspace');
    expect(connection.capabilities.current).toEqual({ model: 'native-model', thinking: 'low' });
    const result = connection.prompt(
      { text: 'new input', model: 'requested-alias', thinking: 'high' },
      s,
    );
    await vi.waitFor(() => expect(s.started).toHaveBeenCalled());
    expect(connection.capabilities.current).toEqual({});
    peer.event('turn/completed', codexEvent('turn', { turn: { id: 'turn', status: 'completed' } }));
    await result;
  });
  it('makes process death sticky even when no prompt was active', async () => {
    const peer = new Peer(),
      connection = await connectCodex(peer.transport, '/workspace'),
      listener = vi.fn();
    connection.onFailure?.(listener);
    const error = new Error('dead');
    peer.child.emit('error', error);
    expect(connection.failure).toBe(error);
    expect(listener).toHaveBeenCalledWith(error);
    await expect(connection.prompt({ text: 'must not dispatch' }, sink())).rejects.toThrow('dead');
    expect(peer.frames.some((frame) => frame.method === 'turn/start')).toBe(false);
  });
});

describe('Claude SDK bridge adapter', () => {
  it('reconciles per-block completions without overwriting thinking or duplicating streamed text', async () => {
    const peer = new Peer(),
      connection = await connectClaude(
        peer.transport,
        { command: 'unused', args: [] },
        '/workspace',
      ),
      s = sink();
    const result = connection.prompt({ text: 'hello' }, s),
      call = await peer.call('prompt'),
      turn = String(record(call.params).uuid);
    const stream = (event: RecordValue) =>
      claudeEvent(peer, turn, { type: 'stream_event', parent_tool_use_id: null, event });
    stream({ type: 'message_start', message: { id: 'msg' } });
    stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    });
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reason' },
    });
    claudeEvent(peer, turn, {
      type: 'assistant',
      uuid: 'block-0',
      message: { id: 'msg', content: [{ type: 'thinking', thinking: 'reason' }] },
    });
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    stream({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    });
    const completed = {
      type: 'assistant',
      uuid: 'block-1',
      message: { id: 'msg', content: [{ type: 'text', text: 'answer' }] },
    };
    claudeEvent(peer, turn, completed);
    claudeEvent(peer, turn, completed);
    claudeEvent(peer, turn, { type: 'result', subtype: 'success', is_error: false, usage: {} });
    await expect(result).resolves.toMatchObject({ status: 'completed', nativeId: turn });
    expect([...s.items.values()].filter((item) => item.kind === 'reasoning')).toEqual([
      expect.objectContaining({ text: 'reason', complete: true }),
    ]);
    expect([...s.items.values()].filter((item) => item.kind === 'assistant')).toEqual([
      expect.objectContaining({ text: 'answer', complete: true }),
    ]);
  });
  it('does not dispatch input after configuration failure, and records delivery only after configure succeeds', async () => {
    const peer = new Peer(),
      fallback = peer.handler;
    peer.handler = (method, params) => {
      if (method === 'configure') throw new Error('model refused');
      return fallback(method, params);
    };
    const connection = await connectClaude(
        peer.transport,
        { command: 'unused', args: [] },
        '/workspace',
      ),
      s = sink();
    await expect(connection.prompt({ text: 'hello', model: 'bad' }, s)).rejects.toThrow(
      'model refused',
    );
    expect(s.beforeDispatch).not.toHaveBeenCalled();
    expect(peer.frames.some((frame) => frame.method === 'prompt')).toBe(false);
    expect(connection.failure).toBeUndefined();
  });
  it('fences previous turn results and permissions; stop intent does not replace a real API failure', async () => {
    const peer = new Peer(),
      connection = await connectClaude(
        peer.transport,
        { command: 'unused', args: [] },
        '/workspace',
      ),
      s = sink();
    const result = connection.prompt({ text: 'hello' }, s),
      call = await peer.call('prompt'),
      turn = String(record(call.params).uuid);
    claudeEvent(peer, 'old', { type: 'result', is_error: false, usage: {} });
    peer.emit({
      id: 'old',
      method: 'permission',
      params: { sessionId: 'claude-session', turnId: 'old', name: 'Bash', input: {} },
    });
    await expect(peer.reply('old')).resolves.toHaveProperty('error');
    expect(s.interaction).not.toHaveBeenCalled();
    await connection.stop();
    claudeEvent(peer, turn, {
      type: 'result',
      is_error: true,
      errors: ['API failed'],
      terminal_reason: 'api_error',
      usage: {},
    });
    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'API failed' });
  });
  it('recognizes an explicit bridge-local cancellation without fabricating a native turn identity', async () => {
    const peer = new Peer(),
      connection = await connectClaude(
        peer.transport,
        { command: 'unused', args: [] },
        '/workspace',
      ),
      s = sink();
    const result = connection.prompt({ text: 'queued in bridge' }, s),
      call = await peer.call('prompt'),
      turn = String(record(call.params).uuid);
    peer.event('admission_cancelled', { sessionId: 'claude-session', turnId: turn });
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(s.started).not.toHaveBeenCalled();
  });
  it('withdraws a native permission and rejects reconnect-free reuse after SDK iterator failure', async () => {
    const peer = new Peer(),
      connection = await connectClaude(
        peer.transport,
        { command: 'unused', args: [] },
        '/workspace',
      ),
      s = sink();
    s.interaction = vi.fn(cancellableInteraction);
    const result = connection.prompt({ text: 'hello' }, s),
      call = await peer.call('prompt'),
      turn = String(record(call.params).uuid);
    peer.emit({
      id: 'permission',
      method: 'permission',
      params: { sessionId: 'claude-session', turnId: turn, name: 'Bash', input: {} },
    });
    await vi.waitFor(() => expect(s.interaction).toHaveBeenCalledOnce());
    peer.event('permission_cancelled', {
      sessionId: 'claude-session',
      turnId: turn,
      id: 'permission',
    });
    await expect(peer.reply('permission')).resolves.toHaveProperty('result.behavior', 'deny');
    const rejection = expect(result).rejects.toThrow('iterator died');
    peer.event('failure', { message: 'iterator died' });
    await rejection;
    expect(connection.failure?.message).toBe('iterator died');
    await expect(connection.prompt({ text: 'again' }, sink())).rejects.toThrow('iterator died');
  });
});

describe('Pi 1.5 session RPC', () => {
  it('requires the explicit stable contract family, never guesses from timeouts', () => {
    for (const value of ['1.5.0', 'pi v1.5.0', '@earendil-works/pi-coding-agent@1.6.2'])
      expect(requirePiRpcVersion(value)).toMatch(/^1\./);
    for (const value of [
      undefined,
      '0.60.0',
      '1.4.9',
      '2.0.0',
      '1.5.0-rc.1',
      'pi 1.5.0 node 24.1.0',
    ])
      expect(() => requirePiRpcVersion(value)).toThrow('>=1.5.0');
  });
  it('reconstructs delta-only updates, authoritative finals and usage, waiting through retries until session settlement', async () => {
    const peer = new Peer('pi'),
      connection = await pi(peer),
      s = sink(),
      result = connection.prompt({ text: 'hello' }, s);
    await peer.call('prompt');
    peer.emit({ type: 'agent_start' });
    peer.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    peer.emit({
      type: 'message_update',
      usage: { input: 10, output: 1 },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
    });
    expect([...s.items.values()].find((item) => item.kind === 'assistant')?.text).toBe('partial');
    peer.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'retry error' }],
        stopReason: 'error',
        errorMessage: 'temporary',
        usage: { input: 10, output: 2 },
      },
    });
    peer.emit({
      type: 'agent_end',
      willRetry: true,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'temporary' }],
    });
    let done = false;
    void result.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    peer.emit({ type: 'agent_start' });
    peer.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    peer.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'reason' },
    });
    peer.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'answer' },
    });
    peer.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reason' },
          { type: 'text', text: 'final' },
        ],
        stopReason: 'stop',
        usage: { input: 20, output: 3 },
      },
    });
    peer.emit({
      type: 'agent_end',
      willRetry: false,
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    });
    await Promise.resolve();
    expect(done).toBe(false);
    peer.emit({ type: 'agent_settled', aborted: false });
    await expect(result).resolves.toMatchObject({ status: 'completed' });
    expect([...s.items.values()].filter((item) => item.text === 'final')).toHaveLength(1);
    expect(s.usage).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: 30, output: 5, scope: 'turn' }),
    );
  });
  it('finishes handled extension input without waiting for an agent run', async () => {
    const peer = new Peer('pi'),
      fallback = peer.handler;
    peer.handler = (method, params) =>
      method === 'prompt' ? { disposition: 'handled' } : fallback(method, params);
    const connection = await pi(peer),
      s = sink();
    await expect(connection.prompt({ text: '/command' }, s)).resolves.toEqual({
      status: 'completed',
    });
    expect(s.beforeDispatch).toHaveBeenCalledOnce();
    expect(s.started).not.toHaveBeenCalled();
  });
  it('reports native aborts even without stop intent and never settles at agent_end', async () => {
    const peer = new Peer('pi'),
      connection = await pi(peer),
      result = connection.prompt({ text: 'hello' }, sink());
    await peer.call('prompt');
    peer.emit({ type: 'agent_start' });
    peer.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    peer.emit({ type: 'agent_settled', aborted: true });
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });
  it('serializes confirm, text and cancellation with the exact extension UI wire shapes', async () => {
    const peer = new Peer('pi'),
      connection = await pi(peer),
      s = sink();
    s.interaction = vi.fn(async (request) =>
      request.id.includes('confirm') ? { optionId: 'yes' } : { cancelled: true },
    );
    const result = connection.prompt({ text: 'hello' }, s);
    await peer.call('prompt');
    peer.emit({ type: 'agent_start' });
    peer.emit({
      type: 'extension_ui_request',
      id: 'confirm',
      method: 'confirm',
      title: 'Proceed?',
    });
    await expect(
      peer.frame((frame) => frame.type === 'extension_ui_response' && frame.id === 'confirm'),
    ).resolves.toEqual({ type: 'extension_ui_response', id: 'confirm', confirmed: true });
    peer.emit({ type: 'extension_ui_request', id: 'input', method: 'input', title: 'Text' });
    await expect(
      peer.frame((frame) => frame.type === 'extension_ui_response' && frame.id === 'input'),
    ).resolves.toEqual({ type: 'extension_ui_response', id: 'input', cancelled: true });
    peer.emit({ type: 'agent_settled', aborted: false });
    await result;
  });
  it('cancels pending extension UI before awaiting native abort and ignores post-settlement output', async () => {
    const peer = new Peer('pi'),
      fallback = peer.handler,
      s = sink();
    s.interaction = vi.fn(cancellableInteraction);
    peer.handler = async (method, params) => {
      if (method !== 'abort') return fallback(method, params);
      await peer.frame(
        (frame) =>
          frame.type === 'extension_ui_response' &&
          frame.id === 'pending' &&
          frame.cancelled === true,
      );
      peer.emit({ type: 'agent_settled', aborted: true });
      return {};
    };
    const connection = await pi(peer),
      result = connection.prompt({ text: 'hello' }, s);
    await peer.call('prompt');
    peer.emit({ type: 'agent_start' });
    peer.emit({ type: 'extension_ui_request', id: 'pending', method: 'confirm' });
    await vi.waitFor(() => expect(s.interaction).toHaveBeenCalledOnce());
    await connection.stop();
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
    const count = s.item.mock.calls.length;
    peer.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'too late' }] },
    });
    expect(s.item).toHaveBeenCalledTimes(count);
  });
  it('distinguishes a documented rejection-before-acceptance from an ambiguous acknowledgement timeout', async () => {
    const peer = new Peer('pi'),
      fallback = peer.handler;
    peer.handler = (method, params) => {
      if (method === 'prompt') throw new Error('input rejected before acceptance');
      return fallback(method, params);
    };
    const connection = await pi(peer);
    await expect(connection.prompt({ text: 'hello' }, sink())).resolves.toEqual({
      status: 'failed',
      error: 'input rejected before acceptance',
    });
    expect(connection.failure).toBeUndefined();
    const request = peer.transport.request.bind(peer.transport);
    vi.spyOn(peer.transport, 'request').mockImplementation((method, params, options) =>
      method === 'prompt'
        ? Promise.reject(new HarnessProtocolError('prompt', 'request_timeout', 'unknown receipt'))
        : request(method, params, options),
    );
    await expect(connection.prompt({ text: 'not known rejected' }, sink())).rejects.toThrow(
      'unknown receipt',
    );
  });
  it('treats unknown prompt dispositions as a fatal uncertain admission, never as permission to resend', async () => {
    const peer = new Peer('pi'),
      fallback = peer.handler;
    peer.handler = (method, params) =>
      method === 'prompt' ? { disposition: 'future-disposition' } : fallback(method, params);
    const connection = await pi(peer),
      listener = vi.fn();
    connection.onFailure?.(listener);
    await expect(connection.prompt({ text: 'hello' }, sink())).rejects.toThrow(
      'may have been accepted',
    );
    expect(listener).toHaveBeenCalledOnce();
    await expect(connection.prompt({ text: 'do not replay' }, sink())).rejects.toThrow(
      'may have been accepted',
    );
    expect(peer.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
  });
  it('does not mark delivery after model failure, and publishes effective native options after setters', async () => {
    const peer = new Peer('pi'),
      fallback = peer.handler;
    peer.handler = (method, params) => {
      if (method === 'set_model') throw new Error('model unavailable');
      return fallback(method, params);
    };
    const connection = await pi(peer),
      s = sink();
    await expect(connection.prompt({ text: 'hello', model: 'provider/bad' }, s)).rejects.toThrow(
      'model unavailable',
    );
    expect(s.beforeDispatch).not.toHaveBeenCalled();
    expect(peer.frames.some((frame) => frame.type === 'prompt')).toBe(false);
    expect(connection.capabilities.current).toEqual({ model: 'provider/model', thinking: 'low' });
    expect(connection.capabilities.models[0]?.thinkingLevels).toEqual(['off', 'low', 'high']);
  });
  it('refuses changed resume identity without silently creating a new native session', async () => {
    const peer = new Peer('pi');
    await expect(pi(peer, '/other.jsonl')).rejects.toThrow('restore');
    expect(peer.frames.map((frame) => frame.type)).toEqual(['get_state']);
  });
});

describe('Dedicated pre-dispatch and failed-generation boundaries', () => {
  for (const harness of ['codex', 'claude', 'pi'] as const) {
    async function open(peer: Peer) {
      return harness === 'codex'
        ? connectCodex(peer.transport, '/workspace')
        : harness === 'claude'
          ? connectClaude(peer.transport, { command: 'unused', args: [] }, '/workspace')
          : pi(peer);
    }
    if (harness !== 'claude')
      it(`${harness} retries failed model discovery in the same native session without dispatching input`, async () => {
        const peer = new Peer(harness === 'pi' ? 'pi' : 'rpc'),
          fallback = peer.handler;
        let healthy = false;
        peer.handler = (method, params) => {
          if (
            method === 'model/list' ||
            method === 'get_available_models' ||
            method === 'capabilities'
          ) {
            if (!healthy) throw new Error('catalog temporarily unavailable');
            return method === 'model/list'
              ? { data: [{ id: 'recovered' }] }
              : { models: [{ provider: 'provider', id: 'recovered' }] };
          }
          return fallback(method, params);
        };
        const connection = await open(peer),
          session = connection.sessionId,
          listener = vi.fn();
        expect(connection.capabilities.modelsError).toBeTruthy();
        expect(connection.capabilities.modelsRefresh).toBe(true);
        connection.onCapabilities?.(listener);
        healthy = true;
        expect(connection.refreshCapabilities).toBeTypeOf('function');
        await connection.refreshCapabilities?.();
        expect(connection.sessionId).toBe(session);
        expect(connection.capabilities.modelsError).toBeUndefined();
        expect(connection.capabilities.models.map((model) => model.id)).toEqual([
          harness === 'pi' ? 'provider/recovered' : 'recovered',
        ]);
        expect(listener).toHaveBeenCalled();
        healthy = false;
        await connection.refreshCapabilities?.();
        expect(connection.capabilities.modelsError).toContain('temporarily unavailable');
        expect(connection.capabilities.models).toHaveLength(1);
        expect(
          peer.frames.some(
            (frame) =>
              frame.method === 'turn/start' || frame.method === 'prompt' || frame.type === 'prompt',
          ),
        ).toBe(false);
      });
    it(`${harness} rejects unsupported controls before delivery and can stop at the commit hook without sending input`, async () => {
      const peer = new Peer(harness === 'pi' ? 'pi' : 'rpc'),
        connection = await open(peer),
        s = sink();
      await expect(
        connection.prompt({ text: 'unsupported', config: { danger: 'bypass' } }, s),
      ).rejects.toThrow('does not expose');
      expect(s.beforeDispatch).not.toHaveBeenCalled();
      const hook = deferred<void>();
      s.beforeDispatch = vi.fn(() => hook.promise);
      const result = connection.prompt({ text: 'stop before wire' }, s);
      await vi.waitFor(() => expect(s.beforeDispatch).toHaveBeenCalledOnce());
      await connection.stop();
      hook.resolve();
      await expect(result).resolves.toEqual({ status: 'cancelled' });
      expect(
        peer.frames.some(
          (frame) =>
            frame.method === 'turn/start' || frame.method === 'prompt' || frame.type === 'prompt',
        ),
      ).toBe(false);
    });
    it(`${harness} never reuses a dead connection, while an explicit new connection preserves the original session`, async () => {
      const peer = new Peer(harness === 'pi' ? 'pi' : 'rpc'),
        connection = await open(peer),
        listener = vi.fn();
      connection.onFailure?.(listener);
      peer.child.emit('error', new Error('process died'));
      await expect(connection.prompt({ text: 'must not run' }, sink())).rejects.toThrow(
        'process died',
      );
      expect(listener).toHaveBeenCalledOnce();
      const fresh = new Peer(harness === 'pi' ? 'pi' : 'rpc');
      const restored =
        harness === 'codex'
          ? await connectCodex(fresh.transport, '/workspace', 'thread')
          : harness === 'claude'
            ? await connectClaude(
                fresh.transport,
                { command: 'unused', args: [] },
                '/workspace',
                'claude-session',
              )
            : await pi(fresh, '/pi/session.jsonl');
      expect(restored.sessionId).toBe(connection.sessionId);
      expect(
        fresh.frames.some(
          (frame) =>
            frame.method === 'turn/start' || frame.method === 'prompt' || frame.type === 'prompt',
        ),
      ).toBe(false);
    });
  }
});

it('does not advertise live Claude model refresh when the pinned SDK only exposes initialization metadata', async () => {
  const peer = new Peer(),
    fallback = peer.handler;
  peer.handler = (method, params) =>
    method === 'initialize'
      ? { sessionId: 'claude-session', bridgeProtocol: 2 }
      : fallback(method, params);
  const connection = await connectClaude(
    peer.transport,
    { command: 'unused', args: [] },
    '/workspace',
  );
  expect(connection.capabilities.modelsError).toContain('reconnect');
  expect(connection.capabilities.modelsRefresh).not.toBe(true);
  expect(connection.refreshCapabilities).toBeUndefined();
  expect(peer.frames.some((frame) => frame.method === 'prompt')).toBe(false);
});
