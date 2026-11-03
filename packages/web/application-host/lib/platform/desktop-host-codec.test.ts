import { expect, it } from 'vitest';
import { createDesktopHostDecoder, createDesktopHostWriter, DESKTOP_HOST_MESSAGE_BYTES, type DesktopHostChunk } from '../../desktop-host-codec.js';
import { desktopHostEnvelope, type DesktopHostFrame } from '../../desktop-host-protocol.js';
const large = (id: string, value = '😀中文'.repeat(15000)): DesktopHostFrame => ({ ...desktopHostEnvelope, kind: 'response', id, ok: true, result: { value } });
async function encoded(frame: DesktopHostFrame) {
  const lines: string[] = [];
  await createDesktopHostWriter('shell', async line => { lines.push(line); })(frame);
  return lines.map(line => JSON.parse(line) as DesktopHostChunk);
}
it('roundtrips large Unicode CDP values without splitting UTF-8 or base64 conversion', async () => {
  const original = large('host:1');
  const frames = await encoded(original);
  expect(frames.length).toBeGreaterThan(2);
  const decoder = createDesktopHostDecoder('shell');
  let result: DesktopHostFrame | undefined;
  for (const frame of frames) {
    expect(Buffer.byteLength(frame.data)).toBeLessThanOrEqual(65536);
    expect(Buffer.from(frame.data).toString()).toBe(frame.data);
    result = decoder.accept(frame);
  }
  expect(result).toEqual(original);
  expect(() => decoder.finish()).not.toThrow();
});
it('lets a small cancellation response pass between bulk chunks and permits interleaved transfers', async () => {
  const lines: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const writer = createDesktopHostWriter('shell', async line => { lines.push(line); if (lines.length === 1) await barrier; });
  const first = writer(large('host:1'));
  const second = writer(large('host:2', 'second'.repeat(22000)));
  const control: DesktopHostFrame = { ...desktopHostEnvelope, kind: 'response', id: 'host:3', ok: true, result: 'cancel acknowledged' };
  const cancellation = writer(control);
  release(); await Promise.all([first, second, cancellation]);
  expect(JSON.parse(lines[1]!)).toEqual(control);
  const decoder = createDesktopHostDecoder('shell');
  const decoded = lines.map(line => decoder.accept(JSON.parse(line))).filter(Boolean);
  expect(decoded).toEqual(expect.arrayContaining([large('host:1'), large('host:2', 'second'.repeat(22000)), control]));
  expect(decoded[0]).toEqual(control);
});
it('rejects wrong direction, duplicate/out-of-order chunks, byte mismatch, and incomplete EOF', async () => {
  const frames = await encoded(large('host:1'));
  const first = frames[0]!;
  for (const changed of [{ ...first, id: 'host:chunk1' }, { ...first, sequence: 1 }, { ...first, totalBytes: DESKTOP_HOST_MESSAGE_BYTES + 1 }, { ...first, final: true }]) {
    expect(() => createDesktopHostDecoder('shell').accept(changed)).toThrow('Invalid');
  }
  const duplicate = createDesktopHostDecoder('shell'); duplicate.accept(first);
  expect(() => duplicate.accept(first)).toThrow('Invalid');
  const missing = createDesktopHostDecoder('shell'); missing.accept(first);
  expect(() => missing.finish()).toThrow('Invalid');
  const completed = createDesktopHostDecoder('shell'); frames.forEach(frame => completed.accept(frame));
  expect(() => completed.accept(first)).toThrow('Invalid');
});
it('bounds aggregate declared assembly memory and discards all partial payloads on failure', async () => {
  const frames = await encoded(large('host:1'));
  const decoder = createDesktopHostDecoder('shell');
  decoder.accept({ ...frames[0], totalBytes: DESKTOP_HOST_MESSAGE_BYTES });
  expect(() => decoder.accept({ ...frames[0], id: 'shell:chunk2' })).toThrow('Invalid');
  expect(() => decoder.finish()).not.toThrow();
});
it('a broken pipe fails pending and future sends without replay', async () => {
  let writes = 0;
  const writer = createDesktopHostWriter('host', async () => { writes++; throw new Error('closed pipe'); });
  await expect(writer(large('shell:1'))).rejects.toThrow('closed pipe');
  await expect(writer(large('shell:2'))).rejects.toThrow('closed pipe');
  expect(writes).toBe(1);
});
it('bounds the separate control lane and flushes an accepted bulk transfer before close', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lines: string[] = [];
  const writer = createDesktopHostWriter('host', async line => { lines.push(line); if (lines.length === 1) await gate; });
  const bulk = writer(large('shell:bulk'));
  const controls = Array.from({ length: 64 }, (_, index) => writer({ ...desktopHostEnvelope, kind: 'response', id: `shell:c${index}`, ok: true, result: index }));
  await expect(writer({ ...desktopHostEnvelope, kind: 'response', id: 'shell:overflow', ok: true, result: null })).rejects.toThrow('budget');
  const closing = writer.close();
  await expect(writer(large('shell:late'))).rejects.toThrow('closed');
  release();
  await Promise.all([bulk, ...controls, closing]);
  const decoder = createDesktopHostDecoder('host');
  const decoded = lines.map(line => decoder.accept(JSON.parse(line))).filter(Boolean);
  expect(decoded).toHaveLength(65);
  expect(decoded.at(-1)).toEqual(large('shell:bulk'));
  expect(() => decoder.finish()).not.toThrow();
});
