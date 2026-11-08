import { expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import AdmZip from 'adm-zip';
import { createBotAppearances, prepareBotAppearance } from './bot-appearances.js';
import type { KernelScopedClient } from '../kernel/kernel-client.js';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';
import { createHash } from 'node:crypto';

const png = () => { const canvas = createCanvas(32, 48); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2255aa'; ctx.fillRect(8, 8, 16, 32); return canvas.toBuffer('image/png'); };
it('imports original images and optional state artwork with static portraits and useful format errors', async () => {
  const bytes = png(), original = await prepareBotAppearance(bytes, '角色.png');
  expect(original.asset).toMatchObject({ name: '角色', transparent: true, image: { width: 32, height: 48, mime: 'image/png', animated: false } });
  expect(original.blobs.get(original.asset.image.hash)).toEqual(bytes);
  const zip = new AdmZip();
  zip.addFile('appearance.json', Buffer.from(JSON.stringify({ schemaVersion: 1, name: 'Moon', image: 'images/idle.png', states: { thinking: 'images/think.png' } })));
  zip.addFile('images/idle.png', bytes); zip.addFile('images/think.png', bytes);
  const pack = await prepareBotAppearance(zip.toBuffer(), 'moon.zip');
  expect(pack.asset.states.thinking).toEqual(pack.asset.image);
  expect(pack.asset.portrait.poster).toBe(pack.asset.image.poster);
  zip.addFile('appearance.json', Buffer.from(JSON.stringify({ schemaVersion: 1, name: 'Broken', image: 'missing.png' })));
  await expect(prepareBotAppearance(zip.toBuffer(), 'broken.zip')).rejects.toThrow('missing.png');
  await expect(prepareBotAppearance(Buffer.from('<script>alert(1)</script>'), 'image.png')).rejects.toThrow('PNG');
  const gif = await prepareBotAppearance(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'idle.gif');
  expect(gif.asset.image).toMatchObject({ mime: 'image/gif', animated: true });
  expect(gif.blobs.get(gif.asset.image.poster)?.subarray(1, 4).toString()).toBe('PNG');
});

it('stores media through native record references, shares repeated imports and releases unused library assets', async () => {
  const rows = new Map<string, KernelRecordResult>(), bytes = new Map<string, Buffer>();
  const releaseBlobs = vi.fn(async () => {});
  const client = {
    getRecord: async (_workspace: string, id: string) => rows.get(id) ?? null,
    listRecords: async () => ({ records: [...rows.values()], nextCursor: null }),
    putBlob: vi.fn(async (buffer: Buffer) => { const hash = `sha256-${createHash('sha256').update(buffer).digest('hex')}`; bytes.set(hash, buffer); return { hash, ownerId: hash }; }),
    putRecord: vi.fn(async (input: KernelRecordResult) => { for (const ref of input.references) expect(bytes.has(ref.objectHash)).toBe(true); rows.set(input.recordId, input); }),
    getBlob: async (hash: string, source: { recordId: string; slot: string }, { offset }: { offset: number }) => {
      expect(rows.get(source.recordId)?.references).toContainEqual({ objectHash: hash, slot: source.slot });
      const data = bytes.get(hash)!; const nextOffset = Math.min(offset + 20, data.length);
      return { bytesBase64: data.subarray(offset, nextOffset).toString('base64'), eof: nextOffset === data.length, nextOffset };
    },
    releaseBlobs,
    releaseRecord: async (_operation: string, _workspace: string, id: string) => { rows.delete(id); },
  } as unknown as KernelScopedClient;
  const options = { client: async () => client, workspaceId: 'bots', bots: async () => [] };
  const library = createBotAppearances(options), image = png();
  const imported = await library.import(image, 'one.png');
  const repeated = await library.import(image, 'one.png');
  expect(repeated.id).toBe(imported.id);
  expect(client.putRecord).toHaveBeenCalledTimes(1);
  expect((await createBotAppearances(options).media(imported.id, imported.image.hash)).bytes).toEqual(image);
  expect(releaseBlobs).toHaveBeenCalledTimes(1);
  await expect(library.media(imported.id, 'f'.repeat(64))).rejects.toThrow('not found');
  await library.remove(imported.id);
  expect(await library.list()).toEqual([]);
});
