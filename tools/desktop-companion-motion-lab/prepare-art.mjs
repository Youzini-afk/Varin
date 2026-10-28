import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const entries = JSON.parse(await readFile(new URL('./shared-art-assets.json', import.meta.url), 'utf8'));
// Resolve against this module, so invocation does not depend on the shell cwd.
// Validate every source before writing any output. These copies are ignored by Git.
const contents = await Promise.all(entries.map(async entry => {
  const bytes = await readFile(new URL(entry.source, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error(`Art source changed: ${entry.source}`);
  return { target: fileURLToPath(new URL(entry.target, import.meta.url)), bytes };
}));
for (const { target, bytes } of contents) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
console.log(`Prepared ${contents.length} shared art files from repository sources.`);
