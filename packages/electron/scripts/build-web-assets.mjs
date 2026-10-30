import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFrontend, repository } from '../../../scripts/build-products.mjs';
import { commitWebAssetGeneration } from './commit-web-asset-generation.mjs';
import { prepareCompanionCatalog, stageDesktopWebAsset } from './companion-assets.mjs';

/** Stage an already prepared browser product without building a Web Host, CLI or native kernel. */
export async function stageDesktopUi(source) {
  const resources = path.join(repository, 'packages/electron/resources');
  await fs.mkdir(resources, { recursive: true });
  const candidateDir = await fs.mkdtemp(path.join(resources, 'web-dist-staging-'));
  const removeDir = target => fs.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  try {
    await fs.cp(source, candidateDir, { recursive: true, filter: filename => stageDesktopWebAsset(path.relative(source, filename)) });
    await prepareCompanionCatalog({ output: path.join(candidateDir, 'companion-catalog.json') });
    const result = await commitWebAssetGeneration({ activeDir: path.join(resources, 'web-dist'), candidateDir,
      backupDir: path.join(resources, `web-dist-backup-${process.pid}`),
      rename: (from, to) => fs.rename(from, to), removeDir, exists: filename => fsSync.existsSync(filename),
    });
    if (!result.ok) throw result.recoveryError ? new AggregateError([result.error, result.recoveryError]) : result.error;
    if (result.backupCleanupWarning) console.warn(result.backupCleanupWarning);
  } catch (error) { await removeDir(candidateDir).catch(() => {}); throw error; }
  console.log('[build] desktop UI staged');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await stageDesktopUi((await prepareFrontend()).directory);
