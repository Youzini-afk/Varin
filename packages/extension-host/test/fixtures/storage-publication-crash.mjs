// A real owner in a separate process; the only interception is the crash point.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { ExtensionStorageStore } from '../../src/storage-store.ts';
import { ExtensionCatalogStore } from '../../src/catalog-store.ts';
const [dataDir, point] = process.argv.slice(2);
const crash = () => {
  fs.writeFileSync(join(dataDir, 'crash-point'), point);
  process.kill(process.pid, 'SIGKILL');
};
if (point === 'first-document') {
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    await rename(from, to);
    if (String(to).includes(`${join('extensions', 'storage')}${process.platform === 'win32' ? '\\' : '/'}`) && String(to).endsWith('.json')) crash();
  };
  syncBuiltinESMExports();
}
const storage = new ExtensionStorageStore(dataDir);
const catalog = new ExtensionCatalogStore(dataDir);
const state = await catalog.read();
const entry = state.document.extensions['example.publication'];
const transactions = await Promise.all(['first', 'second'].map(key => storage.prepareMigration(
  { extensionId: entry.manifest.id, scope: 'application', key }, 2, ({ data }) => ({ ...data, migrated: true }),
)));
await storage.publishPrepared(transactions, {
  extensionId: entry.manifest.id, previousIntegrity: entry.integrity, candidateIntegrity: entry.candidate.integrity,
}, async id => {
  if (point === 'before-catalog') crash();
  await catalog.selectCandidate(entry.manifest.id, entry.candidate.integrity, state.document.revision, undefined, undefined, id);
  if (point === 'after-catalog') crash();
}, (publication, id) => catalog.resolveStoragePublication(publication, id));
throw new Error(`Crash point not reached: ${point}`);
