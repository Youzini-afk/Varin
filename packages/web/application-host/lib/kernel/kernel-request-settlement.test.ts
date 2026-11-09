import { expect, it, vi } from 'vitest';
import { KernelClient } from './kernel-client.js';
import { KernelClientError, KernelRequestError } from './kernel-error.js';
import { KERNEL_PROTOCOL_VERSION } from './protocol.generated.js';

// Exercise the real private request/response boundary without starting a kernel.
// The controlled transport supplies envelopes; it supplies no settlement classification.
function fixture() {
  const client = new KernelClient({ hostId: 'request-settlement', storageRoot: '/unused', buildVersion: 'test' });
  const port = client as unknown as { transport: { send(frame: Record<string, unknown>): Promise<void>; close(): Promise<void> };
    epoch: string; handshakeResult: unknown;
    consumeFrame(frame: unknown): void; requestRaw(method: string, params: object): Promise<unknown>;
    closed: boolean; failAll(error: Error, terminate?: boolean): void };
  const send = vi.fn(async (_frame: Record<string, unknown>) => {});
  port.transport = { send, close: async () => {} };
  return { client, port, send };
}

it('labels only the matching native response as a finished original request', async () => {
  const f = fixture();
  f.send.mockImplementation(async frame => { queueMicrotask(() => f.port.consumeFrame({ v: KERNEL_PROTOCOL_VERSION,
    kind: 'response', id: frame.id, ok: false, error: { code: 'operation-error', message: 'original rejection', retryable: false } })); });
  await expect(f.port.requestRaw('process.spawn', {})).rejects.toMatchObject({
    name: 'KernelRequestError', method: 'process.spawn', settlement: 'response', code: 'operation-error' });
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('marks a local refusal before enqueueing and never writes it to the transport', async () => {
  const f = fixture(); f.port.closed = true;
  await expect(f.port.requestRaw('process.spawn', {})).rejects.toMatchObject({ method: 'process.spawn', settlement: 'not_dispatched' });
  expect(f.send).not.toHaveBeenCalled();
});

it('keeps a lost response unknown, while a later closed-window request was never dispatched', async () => {
  const f = fixture();
  const lost = new KernelClientError({ code: 'kernel-disconnected', message: 'lost original response' });
  f.send.mockImplementation(async () => { queueMicrotask(() => f.port.failAll(lost)); });
  const first = await f.port.requestRaw('process.spawn', {}).catch(error => error);
  expect(first).toBe(lost); expect(first).not.toBeInstanceOf(KernelRequestError);
  await expect(f.port.requestRaw('process.spawn', {})).rejects.toMatchObject({ settlement: 'not_dispatched' });
  expect(f.send).toHaveBeenCalledTimes(1);
});

it.each(['text.decode', 'text.serialize'] as const)('dispatches the public %s wrapper on the authenticated Host channel after handshake', async method => {
  const f = fixture();
  f.port.epoch = 'authenticated-epoch'; f.port.handshakeResult = {};
  // Controlled response envelope tests the real client wrapper/admission path,
  // not codec correctness, which belongs to the native acceptance suite.
  const format = { encoding: 'utf-8', bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: 'explicit' };
  const result = method === 'text.decode' ? { kind: 'text', content: 'x', byteLength: 1, format }
    : { kind: 'serialized', bytesBase64: 'eA==', byteLength: 1, format };
  f.send.mockImplementation(async frame => { queueMicrotask(() => f.port.consumeFrame({ v: KERNEL_PROTOCOL_VERSION,
    kind: 'response', id: frame.id, ok: true, result })); });
  const params = method === 'text.decode' ? { bytesBase64: 'eA==', encoding: 'utf-8' } : { content: 'x', targetFormat: { encoding: 'utf-8' } };
  expect(await (method === 'text.decode' ? f.client.textDecode({ bytesBase64: 'eA==', encoding: 'utf-8' })
    : f.client.textSerialize({ content: 'x', targetFormat: { encoding: 'utf-8' } }))).toEqual(result);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request', method, params, epoch: 'authenticated-epoch' }), 'data');
  expect(f.send.mock.calls[0]![0]).not.toHaveProperty('grantId');
});

it('does not exempt unrelated unscoped resource requests from grant admission', async () => {
  const f = fixture();
  f.port.epoch = 'authenticated-epoch'; f.port.handshakeResult = {};
  await expect(f.port.requestRaw('file.read', { rootId: 'root', path: 'file.txt' })).rejects.toMatchObject({
    code: 'kernel-grant-required', method: 'file.read', settlement: 'not_dispatched' });
  expect(f.send).not.toHaveBeenCalled();
});
