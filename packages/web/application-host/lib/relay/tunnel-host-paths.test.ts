import { describe, expect, test } from 'vitest';
import { isRelayWebSocketPathAllowed } from './tunnel-host.js';

describe('relay WebSocket path policy', () => {
  test('allows terminal and dictation sockets but rejects retired runtime and arbitrary API upgrades', () => {
    expect(isRelayWebSocketPathAllowed('/api/terminal/ws')).toBe(true);
    expect(isRelayWebSocketPathAllowed('/api/dictation/ws')).toBe(true);
    expect(isRelayWebSocketPathAllowed('/api/varin/runtime/ws')).toBe(false);
    expect(isRelayWebSocketPathAllowed('/api/threads/observe')).toBe(false);
    expect(isRelayWebSocketPathAllowed('/api/untrusted/ws')).toBe(false);
  });
});
