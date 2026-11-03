/** download-cef 3.0.0 retains Chromium CREDITS but deletes the archive-root CEF
 * license while flattening its SDK. Retain the original pinned source bytes here
 * rather than silently omitting a required redistribution notice. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './runtime-manifest.mjs';

export async function pinnedCefLicense(sdk) {
  const lock = JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json', import.meta.url), 'utf8'));
  const source = fileURLToPath(new URL(lock.license.file, import.meta.url));
  if (await sha256(source) !== lock.license.sha256) throw new Error('Pinned CEF license bytes changed');
  if (sdk) {
    const original = path.join(sdk, 'LICENSE.txt');
    const present = await fs.stat(original).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (present && await sha256(original) !== lock.license.sha256) throw new Error('CEF SDK license differs from the pinned source license');
  }
  return source;
}
