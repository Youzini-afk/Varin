import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { attachContentLengthReader, writeContentLengthMessage } from '../run/content-length.js';
import { createJsonRpcClient } from './jsonrpc.js';

it('cancels only the named request, ignores its late response and retains another waiter', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  const detach = attachContentLengthReader(output, frame => { frames.push(frame); });
  const rpc = createJsonRpcClient({ input, output });
  try {
    const controller = new AbortController();
    const first = rpc.request('textDocument/documentSymbol', { textDocument: { uri: 'file:///a.cs' } }, controller.signal);
    const second = rpc.request('textDocument/documentSymbol', { textDocument: { uri: 'file:///b.cs' } });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(frames).toContainEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } });
    writeContentLengthMessage(input, { jsonrpc: '2.0', id: 1, result: ['late'] });
    writeContentLengthMessage(input, { jsonrpc: '2.0', id: 2, result: ['retained'] });
    expect(await second).toEqual(['retained']);
    const count = frames.length;
    await expect(rpc.request('initialize', {}, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(frames).toHaveLength(count);
  } finally { rpc.dispose(); detach(); input.destroy(); output.destroy(); }
});

it('answers a server request without confusing its ID with the client request', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  const detach = attachContentLengthReader(output, (frame) => frames.push(frame));
  const rpc = createJsonRpcClient({ input, output, onRequest: (method) => {
    expect(method).toBe('workspace/configuration');
    return [null];
  } });
  try {
    let finished = false;
    const reply = rpc.request('initialize', {}).then((value) => { finished = true; return value; });
    writeContentLengthMessage(input, { jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(frames).toContainEqual({ jsonrpc: '2.0', id: 1, result: [null] });
    writeContentLengthMessage(input, { jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    expect(await reply).toEqual({ capabilities: {} });
  } finally { rpc.dispose(); detach(); input.destroy(); output.destroy(); }
});
