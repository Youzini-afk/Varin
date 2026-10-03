import { afterEach, describe, expect, test } from 'vitest';
import {
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  VARIN_PROTOCOL_VERSION,
} from '@varin/protocol';
import type {
  RuntimeWebSocket,
} from '@varin/runtime-client';
import {
  createPiRuntimeConnection,
  disconnectPiRuntime,
} from './client';

class HandshakeSocket implements RuntimeWebSocket {
  readonly readyState = 1;
  onclose: RuntimeWebSocket['onclose'] = null;
  onerror: RuntimeWebSocket['onerror'] = null;
  onmessage: RuntimeWebSocket['onmessage'] = null;
  onopen: RuntimeWebSocket['onopen'] = null;

  close(): void {}

  send(frame: string): void {
    const request = decodeRuntimeEnvelope(frame);
    if (request.kind !== 'request' || request.method !== 'host.handshake') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: encodeRuntimeEnvelope(createRuntimeSuccessResponse(request.id, {
          capabilities: {
            agentProviders: true,
            extensionUi: true,
            fleet: true,
            models: true,
            packages: true,
            providerConfiguration: true,
            recovery: true,
            resources: true,
            sessions: true,
            settings: true,
          },
          hostVersion: '0.1.0',
          protocolVersion: VARIN_PROTOCOL_VERSION,
          runtime: {
            agentDir: 'C:/agent',
            nodePath: 'node',
            nodeVersion: '24.0.0',
            piVersion: '0.83.0',
            source: 'bundled',
          },
        })),
      });
    });
  }
}

afterEach(async () => {
  await disconnectPiRuntime();
});

describe('Pi runtime UI connection', () => {
  test('an auth request that never answers cannot poison the shared connection attempt', async () => {
    let release!: (token: string) => void;
    let opened = 0;
    const auth = new Promise<string>((resolve) => { release = resolve; });
    const connection = createPiRuntimeConnection({
      refreshAuth: () => auth,
      startupTimeoutMs: 20,
      runtimeKey: 'runtime-test',
      resolveWebSocketUrl: () => 'ws://runtime.test',
      openSocket: () => { opened++; return new HandshakeSocket(); },
    });
    await expect(connection).rejects.toThrow('timed out during authentication');
    release('late-token');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(0);
  });

  test('closes a silent handshake instead of waiting forever before dispatch', async () => {
    let closed = false;
    let sends = 0;
    const connection = createPiRuntimeConnection({
      runtimeKey: 'runtime-test', startupTimeoutMs: 20,
      transport: {
        start: () => undefined,
        send: () => { sends++; },
        close: () => { closed = true; },
      },
    });
    await expect(connection).rejects.toThrow('timed out during handshake');
    expect(closed).toBe(true);
    expect(sends).toBe(1);
  });

  test('mints URL auth before opening and handshakes over the shared socket contract', async () => {
    const order: string[] = [];
    const socket = new HandshakeSocket();
    const connectionPromise = createPiRuntimeConnection({
      mode: 'web',
      openSocket: () => {
        order.push('socket');
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      refreshAuth: async () => {
        order.push('auth');
        return 'url-token';
      },
      resolveWebSocketUrl: () => 'ws://runtime.test/api/varin/runtime/ws',
      runtimeKey: 'runtime-test',
    });

    const connection = await connectionPromise;
    expect(order).toEqual(['auth', 'socket']);
    expect(connection.handshake.runtime.piVersion).toBe('0.83.0');
    expect(connection.runtimeKey).toBe('runtime-test');
    await connection.client.close();
  });

});
