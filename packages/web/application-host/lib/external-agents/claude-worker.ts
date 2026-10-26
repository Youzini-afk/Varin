/** SDK bridge runs inside a Rust-owned process tree, including the SDK's CLI child. */
import {
  query,
  type Query,
  type SDKUserMessage,
  type PermissionResult,
  type Options,
} from '@anthropic-ai/claude-agent-sdk/core';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { record, text, type RecordValue } from './transport.js';

const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let session: Query | undefined;
let sessionId = '';
const queue: SDKUserMessage[] = [];
let wake: (() => void) | undefined;
let closed = false;
let interrupts = 0;
const approvals = new Map<string, (value: PermissionResult) => void>();
async function* inputs(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    if (!queue.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    while (queue.length) yield queue.shift()!;
  }
}
async function handle(message: RecordValue): Promise<unknown> {
  const p = record(message.params);
  if (message.method === 'initialize') {
    if (session) throw new Error('Claude bridge is already initialized');
    sessionId = text(p.sessionId) || randomUUID();
    const launcher = record(p.launcher);
    const startupArgs = Array.isArray(launcher.args) ? launcher.args.map(String) : [];
    const options: Options = {
      cwd: text(p.cwd),
      pathToClaudeCodeExecutable: text(launcher.command),
      // This bridge and the SDK CLI belong to the same Rust-managed process tree.
      // Preserve the configured argv exactly, including npm's JS entry and user arguments.
      spawnClaudeCodeProcess: (args) =>
        spawn(text(launcher.command), [...startupArgs, ...args.args], {
          cwd: args.cwd,
          env: args.env,
          signal: args.signal,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      ...(p.sessionId ? { resume: sessionId } : { sessionId }),
      canUseTool: async (name, input, options) => {
        const id = randomUUID();
        return new Promise<PermissionResult>((resolve) => {
          const cancel = () => {
            approvals.delete(id);
            resolve({ behavior: 'deny', message: 'The interaction was cancelled' });
          };
          options.signal.addEventListener('abort', cancel, { once: true });
          approvals.set(id, (value) => {
            options.signal.removeEventListener('abort', cancel);
            resolve(value);
          });
          output({
            jsonrpc: '2.0',
            id,
            method: 'permission',
            params: { name, input, suggestions: options.suggestions, toolUseId: options.toolUseID },
          });
          if (options.signal.aborted) cancel();
        });
      },
    };
    session = query({ prompt: inputs(), options });
    void (async () => {
      try {
        for await (const event of session!) output({ jsonrpc: '2.0', method: 'message', params: event });
      } catch (error) {
        output({
          jsonrpc: '2.0',
          method: 'failure',
          params: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
    return { sessionId, models: await session.supportedModels() };
  }
  if (!session) throw new Error('Claude bridge has not initialized');
  if (message.method === 'prompt') {
    const before = interrupts;
    if (typeof p.model === 'string') await session.setModel(p.model);
    if (p.thinking !== undefined) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(text(p.thinking)))
        throw new Error('Unsupported Claude effort level');
      await session.applyFlagSettings({
        effortLevel: p.thinking as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
      });
    }
    if (p.mode !== undefined) throw new Error('This Claude connection does not expose a mode control');
    if (interrupts !== before) return { cancelled: true };
    const content = [
      { type: 'text' as const, text: text(p.text) },
      ...(Array.isArray(p.images) ? p.images : []).map((value) => {
        const image = record(value);
        const mime = text(image.mimeType);
        if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif' && mime !== 'image/webp')
          throw new Error('Unsupported image type');
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: text(image.data),
          },
        };
      }),
    ];
    queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    wake?.();
    wake = undefined;
    return { accepted: true };
  }
  if (message.method === 'interrupt') {
    interrupts++;
    await session.interrupt();
    return {};
  }
  throw new Error(`Unsupported Claude bridge method: ${text(message.method)}`);
}
let parts: Buffer[] = [];
let length = 0;
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
      if (!message.method && message.id !== undefined) {
        const approve = approvals.get(String(message.id));
        approvals.delete(String(message.id));
        approve?.(
          message.error
            ? { behavior: 'deny', message: 'The interaction was cancelled' }
            : (message.result as PermissionResult),
        );
      } else
        void handle(message).then(
          (result) => output({ jsonrpc: '2.0', id: message.id, result }),
          (error) =>
            output({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            }),
        );
    } catch {
      output({ jsonrpc: '2.0', method: 'failure', params: { message: 'Invalid Claude bridge message' } });
    }
  }
});
process.stdin.once('end', () => {
  closed = true;
  wake?.();
  session?.close();
});
