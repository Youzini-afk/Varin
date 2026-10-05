#!/usr/bin/env node
/** Fetch the pinned release-default Bekko pack only during an explicit component
 * build. Ordinary Host builds and startup never download a model. */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const destDir = join(dirname(fileURLToPath(import.meta.url)), '..',
  'application-host/lib/knowledge/semantic/runtime/bekko-embedding-v1-a8m');
const recipe = JSON.parse(await readFile(join(destDir, 'recipe.json'), 'utf8'));
const source = JSON.parse(await readFile(join(destDir, 'source.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/u.test(source.revision) || source.revision !== recipe.modelRevision) {
  throw new Error('Default model source must match the pinned recipe revision');
}
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
for (const [name, expected] of Object.entries(source.files)) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/u.test(expected)
    || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '..')) {
    throw new Error('Invalid pinned model source file');
  }
  const target = join(destDir, ...name.split('/'));
  if (await sha256(target).catch(() => null) === expected) {
    console.log(`[copy-semantic-model] verified reuse ${name}`);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.download`;
  const url = `https://huggingface.co/${source.repository}/resolve/${source.revision}/${name}`;
  try {
    console.log(`[copy-semantic-model] fetch ${name}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (await sha256(temporary) !== expected) throw new Error('Downloaded bytes differ from the pinned source');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`Failed to prepare ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
console.log(`[copy-semantic-model] pinned ${recipe.model} pack ready in ${destDir}`);
