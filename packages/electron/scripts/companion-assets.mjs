import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Keep the player and tiny catalog previews; art and developer reviews are optional downloads. */
export const stageDesktopWebAsset = relative => !['companion-assets', 'companion-review-director'].includes(relative.split(/[\\/]/u)[0]);

export async function prepareCompanionCatalog({ repoRoot = repository, output, sourceRevision } = {}) {
  const source = path.join(repoRoot, 'packages/web/public/companion-assets');
  const bundleBytes = await fs.readFile(path.join(source, 'bundle.json'));
  const bundle = JSON.parse(bundleBytes);
  const occlusion = JSON.parse(await fs.readFile(path.join(source, 'occlusion.json'), 'utf8'));
  if (occlusion.bundleSHA256 !== digest(bundleBytes)) throw new Error('Companion occlusion pages do not match the current bundle');
  const names = new Set(['bundle.json', 'occlusion.json', bundle.worldStool.file]);
  for (const item of bundle.packages) for (const page of item.pages) names.add(page.file);
  for (const page of Object.values(occlusion.pages)) names.add(page.file);
  const files = await Promise.all([...names].sort().map(async name => {
    if (!/^[\w.-]+\.(json|png)$/u.test(name)) throw new Error(`Invalid companion asset name: ${name}`);
    const bytes = await fs.readFile(path.join(source, name));
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  }));
  const revision = sourceRevision ?? execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Companion downloads need a committed source revision');
  const catalog = { schemaVersion: 1, packs: [{ id: 'varin', name: 'Varin',
    version: digest(JSON.stringify(files)), bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    baseUrl: `https://raw.githubusercontent.com/Youzini-afk/Varin/${revision}/packages/web/public/companion-assets/`, files,
  }] };
  const destination = output ?? path.join(repoRoot, 'packages/electron/resources/web-dist/companion-catalog.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(catalog, null, 2) + '\n');
  return catalog;
}
