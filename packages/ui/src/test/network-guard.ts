import { setImmediate } from 'node:timers/promises';
import { afterAll, afterEach, expect } from 'vitest';

const unexpectedRequests: string[] = [];

const rejectNetwork = (method: string, input: string | URL | Request): Error => {
  const raw = input instanceof Request ? input.url : String(input);
  let target: string;
  try {
    const url = new URL(raw, 'http://test.invalid');
    // Never report credentials, headers, bodies, or query parameters.
    target = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      ? `${url.origin}${url.pathname}`
      : `[${url.protocol} URL]`;
  } catch {
    target = '[invalid URL]';
  }
  const request = `${method} ${target}`;
  unexpectedRequests.push(request);
  return new Error(`Unmocked UI test network request: ${request}. Mock the owning transport explicitly.`);
};

// Install before test imports, so saved/restored fetch references are guarded too.
// These defaults never delegate to a real network transport, even during cleanup.
globalThis.fetch = async (input, init) => {
  throw rejectNetwork(init?.method ?? (input instanceof Request ? input.method : 'GET'), input);
};

class GuardedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(url: string | URL) {
    throw rejectNetwork('WebSocket', url);
  }
}
globalThis.WebSocket = GuardedWebSocket as unknown as typeof WebSocket;

const assertNoUnmockedRequests = async (): Promise<void> => {
  // Use the real event loop even when a test owns fake timers. Reporting here
  // also catches attempts whose errors were swallowed by background consumers.
  await setImmediate();
  expect(unexpectedRequests.splice(0), 'UI tests must mock every network transport').toEqual([]);
};

afterEach(assertNoUnmockedRequests);
afterAll(assertNoUnmockedRequests);
