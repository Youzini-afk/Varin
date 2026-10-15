import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TerminalHandlers } from '@varin/application-client';
import { createTerminalRuntime } from './runtime.js';
import { readTerminalWsControlFrame } from './terminal-ws-protocol.js';

const state = vi.hoisted(() => ({ server: undefined as unknown as EventEmitter }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { WebSocketServer: class extends EventEmitter {
    clients = new Set();
    constructor() { super(); state.server = this; }
    close(done: () => void) { done(); }
  } };
});
// This Host test loads the real renderer consumer through Vitest's source alias, as
// the gateway integration tests do. Its fixture surface does not enlarge Host's TS root.
interface FixtureSocket {
  readyState: number;
  binaryType: 'arraybuffer';
  onopen: (() => void) | null;
  onmessage: ((event: { data: Uint8Array }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}
const { TerminalTransport } = await vi.importActual<{
  TerminalTransport: new (dependencies: { refreshAuth(): Promise<unknown>; openSocket(): FixtureSocket }) => {
    subscribe(sessionId: string, handlers: TerminalHandlers): () => void;
    write(sessionId: string, data: string): Promise<void>;
    dispose(): void;
  };
}>('@varin/ui/lib/terminalApi');
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Actual frontend transport and Host frame handler, joined by an in-memory WebSocket fixture.
 * No listener or kernel/OS success is inferred from this protocol-level consumer test. */
function fixture() {
  const writes: Array<{ text: string; operationId: string | undefined; resolve(): void; reject(error: Error): void }> = [];
  const stop = vi.fn(); const detach = vi.fn(async () => {});
  const runtime = createTerminalRuntime({ app: { get() {}, post() {}, delete() {} }, server: new EventEmitter(), fs, path,
    uiAuthController: null, buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false,
    isRequestOriginAllowed: async () => true, rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000, TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
  } as unknown as Parameters<typeof createTerminalRuntime>[0]);
  const ready = runtime.adoptTerminalSession!({ sessionId: 'original-terminal', cwd: '/workspace',
    identity: { threadId: 'thread', branchId: 'branch', runId: 'run', operationId: 'process', processId: 'process', kernelEpoch: 'epoch' },
    process: { native: true, pid: 123, kill: stop, detach, completion: new Promise<void>(() => {}),
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {},
      write: (text, operationId) => new Promise<void>((resolve, reject) => writes.push({ text, operationId, resolve, reject })),
    } });
  const sent: Record<string, unknown>[] = [];
  const sockets: FixtureSocket[] = [];
  const transport = new TerminalTransport({ refreshAuth: async () => {}, openSocket: () => {
    const server = Object.assign(new EventEmitter(), { readyState: 1, ping() {},
      send(data: Uint8Array) { queueMicrotask(() => socket.onmessage?.({ data })); },
    });
    const socket: FixtureSocket = { readyState: 0, binaryType: 'arraybuffer', onopen: null, onmessage: null, onerror: null, onclose: null,
      send(data) { const frame = Buffer.from(data as Uint8Array); sent.push(readTerminalWsControlFrame(frame)!); server.emit('message', frame, true); },
      close() { socket.readyState = 3; server.readyState = 3; server.emit('close'); socket.onclose?.({ code: 1000, reason: '' }); },
    };
    sockets.push(socket);
    queueMicrotask(() => { state.server.emit('connection', server); socket.readyState = 1; socket.onopen?.(); });
    return socket;
  } });
  closers.push(async () => { transport.dispose(); await runtime.shutdown(); });
  return { runtime, transport, ready, writes, sent, sockets, stop, detach };
}

it('resolves the actual UI input call only after the original Host writer acknowledgement', async () => {
  const f = fixture(); await f.ready;
  const unsubscribe = f.transport.subscribe('original-terminal', { onEvent() {} });
  let confirmed = false;
  const input = f.transport.write('original-terminal', 'command\r').then(() => { confirmed = true; });
  await tick(); expect(confirmed).toBe(false); expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({ text: 'command\r', operationId: expect.stringMatching(/^terminal-input:/) });
  f.writes[0]!.resolve(); await input; expect(confirmed).toBe(true);
  const messages = f.sent.filter(value => value.t === 'write');
  expect(messages).toEqual([{ t: 'write', v: 4, s: 'original-terminal', i: expect.any(String), d: 'command\r' }]);
  expect(f.stop).not.toHaveBeenCalled(); unsubscribe();
});

it('keeps a lost input acknowledgement unconfirmed without resending and rejects a later partial write', async () => {
  const f = fixture(); await f.ready;
  const unsubscribe = f.transport.subscribe('original-terminal', { onEvent() {}, onError() {} });
  const original = expect(f.transport.write('original-terminal', 'possibly written')).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' });
  await tick(); f.sockets[0]!.close(); await original;
  f.writes[0]!.resolve(); await tick();
  const partial = expect(f.transport.write('original-terminal', 'new explicit input')).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' });
  await tick(); expect(f.writes).toHaveLength(2);
  expect(f.writes[1]!.operationId).not.toBe(f.writes[0]!.operationId);
  expect(f.sent.filter(value => value.t === 'write').map(value => value.d)).toEqual(['possibly written', 'new explicit input']);
  f.writes[1]!.reject(new Error('partial: only the confirmed prefix reached stdin')); await partial;
  expect(f.runtime.inspectSession('original-terminal')?.status).toBe('error');
  expect(f.stop).not.toHaveBeenCalled(); unsubscribe();
});
