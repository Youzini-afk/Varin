import type { RelayFrameChannel } from './e2ee.js';

// Exercise the actual browser peer, never a second handshake implemented by a test.
export const { createClientHandshake } = await import(new URL('../../../../ui/src/lib/relay/handshake.ts', import.meta.url).href) as {
  createClientHandshake(key: unknown, options?: { batch?: boolean }): Promise<{
    helloText: string;
    handleText(text: string): Promise<
      | { type: 'established'; batch: boolean; channel: RelayFrameChannel }
      | { type: 'send-text'; text: string } | { type: 'ignore' }
    >;
  }>;
};
