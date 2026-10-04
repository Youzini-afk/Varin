import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const moduleArg = process.argv.indexOf('--module');
const source = moduleArg < 0
  ? new URL('../packages/web/application-host/lib/documents/workspace-registry.ts', import.meta.url)
  : pathToFileURL(path.resolve(process.argv[moduleArg + 1]));
const { createWorkspaceRegistry } = await import(source.href);

const rootsArg = process.argv.indexOf('--roots');
const lookupsArg = process.argv.indexOf('--lookups');
const roundsArg = process.argv.indexOf('--rounds');
const rootCount = rootsArg < 0 ? 10000 : Number(process.argv[rootsArg + 1]);
const lookups = lookupsArg < 0 ? 100 : Number(process.argv[lookupsArg + 1]);
const rounds = roundsArg < 0 ? 3 : Number(process.argv[roundsArg + 1]);
if (![rootCount, lookups, rounds].every(value => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('roots, lookups and rounds must be positive safe integers');
}
const hostId = 'document-registry-measurement';
const base = path.resolve(path.parse(process.cwd()).root, 'varin-registry-fixture');
const entries = Array.from({ length: rootCount }, (_, index) => ({
  workspaceId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  canonicalPath: path.join(base, `root-${index}`),
}));
const payload = JSON.stringify({ schemaVersion: 1, hostId, workspaces: entries });
const fixture = () => {
  const counts = { reads: 0, writes: 0, renames: 0 };
  const registry = createWorkspaceRegistry({
    hostId,
    filePath: path.join(base, 'workspaces.json'),
    fsPromises: {
      readFile: async () => { counts.reads++; return payload; },
      mkdir: async () => undefined,
      writeFile: async () => { counts.writes++; },
      rename: async () => { counts.renames++; },
      unlink: async () => undefined,
    },
  });
  return { registry, counts };
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measurements = { byId: [], exactPath: [], containingPath: [] };
const coldMs = { firstId: [], firstPath: [] };
let verified = 0;
for (let round = 0; round < rounds; round++) {
  const { registry } = fixture();
  let start = performance.now();
  await registry.get(entries[0].workspaceId);
  coldMs.firstId.push(performance.now() - start);
  start = performance.now();
  await registry.findExact(entries[0].canonicalPath);
  coldMs.firstPath.push(performance.now() - start);
  for (const [name, operation] of [
    ['byId', entry => registry.get(entry.workspaceId)],
    ['exactPath', entry => registry.findExact(entry.canonicalPath)],
    ['containingPath', entry => registry.findContaining(path.join(entry.canonicalPath, 'src', 'index.ts'))],
  ]) {
    const start = performance.now();
    for (let i = 0; i < lookups; i++) {
      const entry = entries[(rootCount - 1 - (i * 37) % rootCount)];
      const result = await operation(entry);
      if (result?.workspaceId !== entry.workspaceId) throw new Error(`Incorrect ${name} lookup`);
      verified++;
    }
    measurements[name].push(performance.now() - start);
  }
}
const cold = fixture();
await Promise.all(Array.from({ length: 32 }, (_, i) => cold.registry.get(entries[i % rootCount].workspaceId)));
const create = fixture();
await Promise.all(Array.from({ length: 16 }, () => create.registry.resolve({
  canonicalPath: path.join(base, 'new-root'), create: true,
})));
console.log(JSON.stringify({
  fixture: { rootCount, lookupsPerRound: lookups, rounds, platform: process.platform, node: process.version },
  verifiedLookups: verified,
  medianMs: Object.fromEntries(Object.entries(measurements).map(([key, values]) => [key, Number(median(values).toFixed(3))])),
  samplesMs: measurements,
  coldMedianMs: Object.fromEntries(Object.entries(coldMs).map(([key, values]) => [key, Number(median(values).toFixed(3))])),
  coldConcurrentLookups: { requests: 32, fileReads: cold.counts.reads },
  concurrentSameRootCreates: { requests: 16, fileReads: create.counts.reads, writes: create.counts.writes, renames: create.counts.renames },
}, null, 2));
