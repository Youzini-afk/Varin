/**
 * Reproducible registry read-path measurement using synthetic, schema-valid
 * retained Threads/Runs and temporary catalog files. Never opens user data.
 *
 * node --import tsx packages/web/scripts/thread-registry-perf.ts
 * Optional: --threads=1000 --scopes=3 --runs=4 --iterations=8
 * Times include public API result cloning. No timing thresholds are asserted.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createThreadRegistry, threadCatalogPath, THREAD_REGISTRY_SCHEMA_VERSION } from "../application-host/lib/harness/thread-registry.js";
import type { Thread, ThreadRun } from "@varin/protocol";

const positiveOption = (name: string, fallback: number): number => {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const threadsPerScope = positiveOption("threads", 1000);
const scopeCount = positiveOption("scopes", 3);
const runsPerThread = positiveOption("runs", 4);
const iterations = positiveOption("iterations", 8);
const hostId = "registry-perf";
const dataDir = await fs.mkdtemp(join(tmpdir(), "varin-registry-perf-"));
const catalogs = new Map<string, number>();
let catalogReads = 0;
let catalogBytesRead = 0;
let directoryReads = 0;
const io = {
  ...fs,
  readFile: ((...args: Parameters<typeof fs.readFile>) => {
    const bytes = catalogs.get(String(args[0]));
    if (bytes !== undefined) { catalogReads += 1; catalogBytesRead += bytes; }
    return fs.readFile(...args);
  }) as typeof fs.readFile,
  readdir: ((...args: Parameters<typeof fs.readdir>) => {
    directoryReads += 1;
    return fs.readdir(...args);
  }) as typeof fs.readdir,
};
let registry = createThreadRegistry({ dataDir, hostId, fsPromises: io });
const measure = async (name: string, count: number, operation: () => Promise<unknown>) => {
  const reads = catalogReads;
  const bytes = catalogBytesRead;
  const directories = directoryReads;
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert(median !== undefined, "A measurement must include at least one sample");
  return {
    name, iterations: count,
    totalMs: Number(samples.reduce((sum, value) => sum + value, 0).toFixed(3)),
    medianMs: Number(median.toFixed(3)),
    catalogReads: catalogReads - reads,
    catalogBytesRead: catalogBytesRead - bytes,
    directoryReads: directoryReads - directories,
  };
};

try {
  const seed = await registry.createThread({
    scopeId: "scope-0", parent: { kind: "session", id: "root-0" }, brief: "Synthetic retained task",
    kind: "implementation", createdBy: "agent", concurrency: 12, autoRun: true,
    worktree: "none", model: { providerId: "fixture", modelId: "fixture" },
    tools: ["read", "bash"], permissions: {},
  });
  const started = await registry.startRun("scope-0", seed.id);
  await registry.markRunRunning("scope-0", seed.id, started.id, "fixture-seed-session");
  const seedThread = await registry.endRun("scope-0", seed.id, started.id, "success");
  const [seedRun] = await registry.listRuns("scope-0", seed.id);
  assert(seedRun, "The seed must retain its completed Run");
  await registry.dispose();

  for (let scope = 0; scope < scopeCount; scope += 1) {
    const scopeId = `scope-${scope}`;
    const threads: Thread[] = [];
    const runs: ThreadRun[] = [];
    for (let index = 0; index < threadsPerScope; index += 1) {
      const threadId = `thread-${scope}-${index}`;
      threads.push({
        ...structuredClone(seedThread), id: threadId, workspaceId: scopeId,
        parent: { kind: "session", id: `root-${scope}` }, eventSeq: index + 1,
        activeRunId: `run-${scope}-${index}-${runsPerThread}`,
      });
      for (let attempt = 1; attempt <= runsPerThread; attempt += 1) {
        const timestamp = new Date(Date.UTC(2026, 0, 1) + attempt * 1000).toISOString();
        runs.push({
          ...structuredClone(seedRun), id: `run-${scope}-${index}-${attempt}`, threadId,
          sessionId: `session-${scope}-${index}-${attempt}`, attempt,
          startedAt: timestamp, lastActivityAt: timestamp, endedAt: timestamp,
        });
      }
    }
    const path = threadCatalogPath(dataDir, hostId, scopeId);
    const body = JSON.stringify({ schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION, scopeId, threads, runs });
    await fs.writeFile(path, body, "utf8");
    catalogs.set(path, Buffer.byteLength(body));
  }
  registry = createThreadRegistry({ dataDir, hostId, fsPromises: io });
  const target = `thread-0-${threadsPerScope - 1}`;
  const ownerSession = `session-${scopeCount - 1}-${threadsPerScope - 1}-${runsPerThread}`;
  const results = [];
  results.push(await measure("coldWorkspaceSnapshot", 1, async () => {
    const snapshots = await registry.listWorkspaceThreadSnapshots("scope-0");
    assert.equal(snapshots.length, threadsPerScope);
    assert.equal(snapshots.at(-1)?.activeRun?.threadId, target);
  }));
  results.push(await measure("warmWorkspaceSnapshot", iterations, async () => {
    const snapshots = await registry.listWorkspaceThreadSnapshots("scope-0");
    assert.equal(snapshots.at(-1)?.activeRun?.attempt, runsPerThread);
  }));
  results.push(await measure("warmSingleThreadSnapshot", iterations * 100, async () => {
    assert.equal((await registry.getThreadSnapshot("scope-0", target))?.activeRun?.attempt, runsPerThread);
  }));
  await registry.resolveSessionOwner("ordinary-root-session");
  results.push(await measure("warmUnboundOwner", iterations, async () => {
    assert.equal(await registry.resolveSessionOwner("ordinary-root-session"), null);
  }));
  results.push(await measure("warmHistoricalOwner", iterations, async () => {
    assert.equal((await registry.resolveSessionOwner(ownerSession))?.owningScopeId, `scope-${scopeCount - 1}`);
  }));
  results.push(await measure("concurrentUnboundOwner", 1, async () => {
    const owners = await Promise.all(Array.from({ length: iterations }, () => registry.resolveSessionOwner("ordinary-root-session")));
    assert(owners.every((owner) => owner === null));
  }));
  console.log(JSON.stringify({
    fixture: { threadsPerScope, scopeCount, runsPerThread, totalCatalogBytes: [...catalogs.values()].reduce((sum, value) => sum + value, 0) },
    results,
  }, null, 2));
} finally {
  await registry.dispose();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
