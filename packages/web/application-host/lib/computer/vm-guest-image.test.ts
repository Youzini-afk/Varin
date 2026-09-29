import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { downloadDebianCloudImage, resolveDebianCloudImage } from './vm-guest-image.js';

it('pins the dated official image reference and rejects a changed download', async () => {
  const bytes = Buffer.from('fixture qcow2');
  const hash = createHash('sha512').update(bytes).digest();
  const ref = 'trixie/20260914-2601/debian-13-generic-amd64-20260914-2601.qcow2';
  const catalog = { items: [{ kind: 'Upload', data: { ref },
    metadata: { annotations: { 'cloud.debian.org/digest': `sha512:${hash.toString('base64')}` } } }] };
  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    requests.push(url);
    return url.endsWith('.json') ? Response.json(catalog) : new Response(bytes);
  }) as typeof fetch;
  const image = await resolveDebianCloudImage(fetchImpl);
  expect(image).toMatchObject({ ref, version: '20260914-2601', sha512: hash.toString('hex') });
  const downloaded = await downloadDebianCloudImage(image, fetchImpl);
  try { expect(await readFile(downloaded.file)).toEqual(bytes); }
  finally { await downloaded.cleanup(); }
  expect(requests[1]).toBe(`https://cloud.debian.org/images/cloud/${ref}`);
  await expect(downloadDebianCloudImage(image, (async () => new Response('changed')) as typeof fetch))
    .rejects.toThrow('digest did not match');
});
