/** SDK bridge runs inside a Rust-owned process tree, including the SDK's CLI child. */
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import { ClaudeBridge } from './claude-bridge.js';
import { record } from './transport.js';
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const bridge = new ClaudeBridge(query, output, () => {
  // A dead SDK iterator must never leave an apparently reusable worker alive.
  // Flush the fatal frame first; the Rust process owner still joins the tree.
  process.stdin.pause();
  process.stdout.write('', () => process.exit(1));
});
let parts: Buffer[] = [],
  length = 0;
process.stdin.on('data', (buffer: Buffer) => {
  let offset = 0;
  while (offset < buffer.length) {
    const index = buffer.indexOf(10, offset),
      end = index < 0 ? buffer.length : index;
    parts.push(buffer.subarray(offset, end));
    length += end - offset;
    if (index < 0) break;
    const line = Buffer.concat(parts, length).toString('utf8');
    parts = [];
    length = 0;
    offset = index + 1;
    if (!line.trim()) continue;
    try {
      const message = record(JSON.parse(line));
      if (!message.method && message.id !== undefined) bridge.respond(message);
      else
        void bridge.handle(message).then(
          (result) => output({ jsonrpc: '2.0', id: message.id, result }),
          (error) =>
            output({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
    } catch {
      output({
        jsonrpc: '2.0',
        method: 'failure',
        params: { message: 'Invalid Claude bridge message' },
      });
      bridge.close();
      process.stdout.write('', () => process.exit(1));
    }
  }
});
process.stdin.once('end', () => bridge.close());
