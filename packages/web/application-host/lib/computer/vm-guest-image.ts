import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HarnessServiceError } from '../harness/service-error.js';

const origin = 'https://cloud.debian.org/images/cloud/';
const imageRefPattern = /^trixie\/([0-9]{8}-[0-9]+)\/debian-13-generic-amd64-\1\.qcow2$/u;

export interface DebianCloudImage {
  ref: string;
  version: string;
  sha512: string;
}

export async function resolveDebianCloudImage(fetchImpl: typeof fetch = fetch): Promise<DebianCloudImage> {
  const response = await fetchImpl(`${origin}trixie/latest/debian-13-generic-amd64.json`, { redirect: 'error' });
  if (!response.ok) throw new HarnessServiceError('unavailable', `Debian image catalog returned ${response.status}`);
  const catalog = await response.json() as { items?: Array<{ kind?: unknown; data?: { ref?: unknown }; metadata?: { annotations?: Record<string, unknown> } }> };
  const entry = catalog.items?.find((item) => item.kind === 'Upload' && typeof item.data?.ref === 'string'
    && imageRefPattern.test(item.data.ref));
  const ref = entry?.data?.ref;
  const digest = entry?.metadata?.annotations?.['cloud.debian.org/digest'];
  if (typeof ref !== 'string' || typeof digest !== 'string' || !digest.startsWith('sha512:')) {
    throw new HarnessServiceError('unavailable', 'Debian image catalog has no verified generic amd64 qcow2 release');
  }
  const sha512 = Buffer.from(digest.slice('sha512:'.length), 'base64');
  if (sha512.length !== 64) throw new HarnessServiceError('unavailable', 'Debian image catalog has an invalid digest');
  return { ref, version: imageRefPattern.exec(ref)![1]!, sha512: sha512.toString('hex') };
}

export async function downloadDebianCloudImage(image: DebianCloudImage, fetchImpl: typeof fetch = fetch): Promise<{
  file: string; cleanup(): Promise<void>;
}> {
  if (!imageRefPattern.test(image.ref) || !/^[0-9a-f]{128}$/u.test(image.sha512)) {
    throw new HarnessServiceError('invalid-params', 'Debian image identity is malformed');
  }
  const folder = await mkdtemp(join(tmpdir(), 'varin-vm-image-'));
  try {
    const response = await fetchImpl(`${origin}${image.ref}`, { redirect: 'error' });
    if (!response.ok || !response.body) throw new HarnessServiceError('unavailable', `Debian image download returned ${response.status}`);
    const file = join(folder, 'base.qcow2');
    const hash = createHash('sha512');
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } }),
      createWriteStream(file, { mode: 0o600 }));
    if (hash.digest('hex') !== image.sha512) throw new HarnessServiceError('unavailable', 'Debian cloud image digest did not match its official catalog');
    return { file, cleanup: () => rm(folder, { recursive: true, force: true }) };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
