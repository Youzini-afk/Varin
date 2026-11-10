import { afterEach, expect, it, vi } from 'vitest';
import type { VarinTextFormat } from '@varin/application-client';
import { bindDocumentTextCodec, documentTextEncodings, inspectDocumentBytes, serializeDocumentText, type DocumentTextCodec } from './inspect.js';

const releases: Array<() => void> = [];
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); });

// Response-only ports identify the active binding. These tests exercise the
// public adapter's lifecycle, not byte decoding or serialization correctness.
const responsePort = (name: string): DocumentTextCodec => {
  const format: VarinTextFormat = { encoding: 'utf-8', bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: name };
  return {
    textDecode: vi.fn(async () => ({ kind: 'text' as const, content: 'x', byteLength: 1, format })),
    textSerialize: vi.fn(async () => ({ kind: 'serialized' as const, bytesBase64: 'eA==', byteLength: 1, format })),
  };
};
const bind = (codec: DocumentTextCodec) => {
  const release = bindDocumentTextCodec(codec);
  releases.push(release);
  return release;
};
const expectBinding = async (name: string | undefined) => {
  const decoded = inspectDocumentBytes(Buffer.from('x'));
  if (name === undefined) await expect(decoded).rejects.toMatchObject({ code: 'failed', statusCode: 503 });
  else await expect(decoded).resolves.toMatchObject({ kind: 'text', format: { source: name } });
  const serialized = serializeDocumentText({ content: 'x', encoding: 'utf-8', bom: false });
  if (name === undefined) await expect(serialized).rejects.toMatchObject({ code: 'failed', statusCode: 503 });
  else await expect(serialized).resolves.toMatchObject({ format: { source: name } });
};

it('has no default codec before the Host binds a live service', async () => {
  await expectBinding(undefined);
});

it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])(
  'restores only live bindings when services are released in order %i, %i, %i', async (...order) => {
    const names = ['host-a', 'host-b', 'host-c'];
    const remove = names.map(name => bind(responsePort(name)));
    const active = new Set([0, 1, 2]);
    await expectBinding('host-c');
    for (const index of order) {
      remove[index]!(); active.delete(index);
      const last = [...active].at(-1);
      await expectBinding(last === undefined ? undefined : names[last]);
      // Releasing the same handle twice cannot remove a different binding.
      remove[index]!();
      await expectBinding(last === undefined ? undefined : names[last]);
    }
  },
);

it('keeps separate leases when the same client is bound twice', async () => {
  const codec = responsePort('shared-client');
  const first = bind(codec), second = bind(codec);
  first();
  await expectBinding('shared-client');
  second();
  await expectBinding(undefined);
  first(); second();
  await expectBinding(undefined);
});

it('forwards the native codec catalog without a second Host whitelist', async () => {
  const entries = [{ encoding: 'shift_jis', label: 'Shift_JIS', read: true, write: true, bom: false, defaultBom: false, stateful: false }];
  const port = { ...responsePort('owner'), textEncodings: vi.fn(async () => entries) };
  bind(port);
  await expect(documentTextEncodings()).resolves.toEqual(entries);
  expect(port.textEncodings).toHaveBeenCalledExactlyOnceWith();
});
