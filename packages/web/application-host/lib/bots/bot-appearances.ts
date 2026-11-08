import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import AdmZip from 'adm-zip';
import { BOT_APPEARANCE_STATES, parseBotAppearanceAsset, type BotAppearanceAsset, type BotAppearanceMedia, type BotAppearanceState, type BotSummary } from '@varin/application-client';
import type { KernelScopedClient } from '../kernel/kernel-client.js';
import { HarnessServiceError } from '../harness/service-error.js';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = (message: string): never => { throw new HarnessServiceError('invalid-params', message); };
export class BotAppearanceInUseError extends Error {}
const imageType = (bytes: Buffer): string => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return invalid('Import a PNG, JPEG, WebP, GIF image or a Bot appearance ZIP.');
};

/** Pure import preparation: all images decode before any durable storage is changed. */
export async function prepareBotAppearance(bytes: Buffer, filename: string): Promise<{ asset: BotAppearanceAsset; blobs: Map<string, Buffer> }> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const blobs = new Map<string, Buffer>(), decoded = new Map<string, BotAppearanceMedia>();
  const add = (data: Buffer) => { const hash = digest(data); blobs.set(hash, data); return hash; };
  const decode = async (data: Buffer) => {
    const key = digest(data), cached = decoded.get(key);
    if (cached) return cached;
    const mime = imageType(data);
    let image;
    try { image = await loadImage(data); } catch { return invalid('The appearance contains an image that could not be decoded.'); }
    const width = image.width, height = image.height;
    if (!width || !height) return invalid('The appearance image has no pixels.');
    // A thumbnail is a display derivative, not a limit on the imported original.
    const ratio = Math.min(1, 512 / Math.max(width, height));
    const canvas = createCanvas(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const poster = add(await canvas.encode('png'));
    const media: BotAppearanceMedia = { hash: add(data), poster, mime, width, height,
      animated: mime === 'image/gif' || (mime === 'image/webp' && data.includes(Buffer.from('ANIM'))) || (mime === 'image/png' && data.includes(Buffer.from('acTL'))) };
    decoded.set(key, media);
    return media;
  };
  let name = basename(filename, extname(filename)) || 'Image', image: BotAppearanceMedia, portrait: BotAppearanceMedia;
  const states: BotAppearanceAsset['states'] = {};
  if (/\.zip$/i.test(filename) || (bytes.length >= 2 && bytes.readUInt16LE(0) === 0x4b50)) {
    let zip: AdmZip;
    try { zip = new AdmZip(bytes); } catch { return invalid('The appearance ZIP could not be read.'); }
    const entries = zip.getEntries(), names = new Set<string>();
    for (const entry of entries) { if (names.has(entry.entryName)) return invalid(`Duplicate appearance file: ${entry.entryName}`); names.add(entry.entryName); }
    const manifestFile = zip.getEntry('appearance.json');
    if (!manifestFile) return invalid('The ZIP must contain appearance.json at its root.');
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(manifestFile.getData().toString('utf8')); } catch { return invalid('appearance.json is not valid JSON.'); }
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.name !== 'string' || !manifest.name.trim()) return invalid('appearance.json requires schemaVersion: 1 and a name.');
    name = manifest.name.trim();
    const readImage = async (file: unknown) => {
      if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => part === '..' || part === '.') || file.includes(':')) return invalid('Appearance images must reference files inside the ZIP.');
      const entry = zip.getEntry(file);
      if (!entry || entry.isDirectory) return invalid(`Appearance image is missing: ${file}`);
      return decode(entry.getData());
    };
    image = await readImage(manifest.image);
    portrait = manifest.portrait === undefined ? image : await readImage(manifest.portrait);
    if (manifest.states !== undefined) {
      if (!manifest.states || typeof manifest.states !== 'object' || Array.isArray(manifest.states)) return invalid('Appearance states must be an object.');
      for (const [state, file] of Object.entries(manifest.states)) {
        if (!BOT_APPEARANCE_STATES.includes(state as BotAppearanceState)) return invalid(`Unknown appearance state: ${state}`);
        states[state as BotAppearanceState] = await readImage(file);
      }
    }
  } else { image = await decode(bytes); portrait = image; }
  const poster = await loadImage(blobs.get(image.poster)!);
  const canvas = createCanvas(poster.width, poster.height), ctx = canvas.getContext('2d');
  ctx.drawImage(poster, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = false;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! < 255) { transparent = true; break; }
  const content = { name, transparent, image, portrait, states };
  return { asset: { id: digest(JSON.stringify(content)), ...content }, blobs };
}

export function createBotAppearances(options: { client(): Promise<KernelScopedClient>; workspaceId: string; bots(): Promise<BotSummary[]>; changed?(): void }) {
  let pending = Promise.resolve<unknown>(undefined);
  const serialize = <T>(task: () => Promise<T>): Promise<T> => { const result = pending.catch(() => undefined).then(task); pending = result; return result; };
  const recordId = (id: string) => { if (!/^[a-f0-9]{64}$/.test(id)) invalid('Invalid appearance ID'); return `bot.appearance:${id}`; };
  const get = async (id: string): Promise<BotAppearanceAsset> => {
    const row = await (await options.client()).getRecord(options.workspaceId, recordId(id));
    if (!row || row.recordType !== 'bot.appearance') throw new HarnessServiceError('not-found', 'Bot appearance not found');
    return parseBotAppearanceAsset(JSON.parse(row.payloadJson));
  };
  return {
    get,
    async list() {
      const client = await options.client(), assets: BotAppearanceAsset[] = [];
      let cursor: number | undefined;
      do {
        const page = await client.listRecords({ workspaceId: options.workspaceId, recordType: 'bot.appearance', pageSize: 100, ...(cursor === undefined ? {} : { cursor }) });
        assets.push(...page.records.map(row => parseBotAppearanceAsset(JSON.parse(row.payloadJson))));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return assets;
    },
    async import(bytes: Buffer, filename: string) {
      const prepared = await prepareBotAppearance(bytes, filename);
      return serialize(async () => {
        const client = await options.client(), id = recordId(prepared.asset.id);
        if (await client.getRecord(options.workspaceId, id)) return get(prepared.asset.id);
        const owners: string[] = [];
        try {
          for (const data of prepared.blobs.values()) owners.push((await client.putBlob(data, `bot-art:${randomUUID()}`)).ownerId);
          await client.putRecord({ operationId: `bot-art:${randomUUID()}`, workspaceId: options.workspaceId, recordId: id, recordType: 'bot.appearance', state: 'active', payloadJson: JSON.stringify(prepared.asset), ownerIds: owners,
            references: [...prepared.blobs.keys()].map(hash => ({ slot: hash, objectHash: `sha256-${hash}` })) });
          options.changed?.();
          return prepared.asset;
        } finally { await client.releaseBlobs(owners); }
      });
    },
    use<T>(id: string, task: () => Promise<T>): Promise<T> { return serialize(async () => { await get(id); return task(); }); },
    remove(id: string) { return serialize(async () => {
      const bots = (await options.bots()).filter(bot => bot.appearance?.kind === 'custom' && bot.appearance.assetId === id);
      if (bots.length) throw new BotAppearanceInUseError(`Appearance is used by: ${bots.map(bot => bot.name).join(', ')}. Change their appearance before removing it.`);
      await (await options.client()).releaseRecord(`bot-art:${randomUUID()}`, options.workspaceId, recordId(id));
      options.changed?.();
    }); },
    async media(id: string, hash: string) {
      const asset = await get(id), media = [asset.image, asset.portrait, ...Object.values(asset.states)];
      const item = media.find(item => item.hash === hash || item.poster === hash);
      if (!item) throw new HarnessServiceError('not-found', 'Appearance image not found');
      const client = await options.client(), chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const chunk = await client.getBlob(`sha256-${hash}`, { recordId: recordId(id), slot: hash }, { offset });
        chunks.push(Buffer.from(chunk.bytesBase64, 'base64'));
        if (chunk.eof) break;
        if (chunk.nextOffset <= offset) throw new Error('Appearance image read did not advance');
        offset = chunk.nextOffset;
      }
      return { bytes: Buffer.concat(chunks), mime: hash === item.poster ? 'image/png' : item.mime };
    },
  };
}
