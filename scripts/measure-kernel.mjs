#!/usr/bin/env node
/** R6 bounded, reproducible subsystem observations. Never opens user data or
 * changes the checkout. The pre-R5 comparison is emitted into a temporary tree. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rounded = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = q => rounded(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]);
  return { samples: values.map(rounded), p50Ms: p(0.5), p95Ms: p(0.95), maxMs: p(1) };
};
const timed = async fn => {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
};
const repeat = async (n, fn) => {
  const first = await timed(fn);
  // Warm both native foreground slots as well as the single Host parser.
  await fn(); await fn();
  const warm = [];
  for (let i = 0; i < n; i++) warm.push((await timed(fn)).ms);
  return { firstCallMs: rounded(first.ms), warmupCalls: 2, warm: summary(warm) };
};
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);

// Samples are deliberately outside event-loop/latency measurement windows.
function memorySample(pids) {
  if (process.platform !== 'win32') return { hostRssBytes: process.memoryUsage().rss, nativeSampleUnavailable: true };
  const command = `@(${pids.join(',')}) | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;rssBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;handles=$p.HandleCount;threads=$p.Threads.Count;cpuMs=$p.TotalProcessorTime.TotalMilliseconds} } | ConvertTo-Json -Compress`;
  const records = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  const processes = [records].flat();
  return { processes, totalRssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0) };
}


/** Current native hot paths on generated data. Both binaries use these same
 * emitted Host adapters; this isolates the kernel change without rebuilding a
 * historical Host or including fixture creation/object upload in timings. */
async function computeHotpaths(output, kernelPath, webRoot) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-compute-hotpaths-'));
  const corpus = path.join(temporary, 'workspace');
  const pids = [process.pid];
  let client;
  try {
    await fsp.mkdir(path.join(corpus, 'src'), { recursive: true });
    const hostRoot = path.join(webRoot, 'server');
    const [{ createKernelClient }, { runKernelCompute }, queries] = await Promise.all([
      load(hostRoot, 'lib/kernel/kernel-client.js'),
      load(hostRoot, 'lib/kernel/compute-runner.js'),
      load(hostRoot, 'lib/structure/queries.js'),
    ]);
    const buildVersion = JSON.parse(await fsp.readFile(path.join(repo, 'package.json'), 'utf8')).version;
    client = createKernelClient({ hostId: 'compute-hotpaths', storageRoot: path.join(temporary, 'state'),
      buildVersion, kernelPath, allowCargoDevRunner: false,
      spawnProcess: (...args) => { const child = spawn(...args); if (child.pid) pids.push(child.pid); return child; },
    });
    await client.start();
    const scoped = client.scoped(await client.issueGrant({ grantId: 'hotpath-owner',
      owningWorkspace: 'ws', executionWorkspace: 'ws', pathScopes: [''],
      capabilities: ['storage.read', 'storage.write', 'storage.gc', 'compute.grammar'] }));
    const registered = await scoped.fileRootRegister({ workspaceId: 'ws', executionWorkspaceId: 'ws', canonicalRoot: corpus });
    const address = { workspaceId: 'ws', rootId: String(registered.rootId), lane: 'background' };
    const samples = 8;
    const large = Buffer.from(('captured payload 中文 stable bytes\n').repeat(850000));
    await fsp.writeFile(path.join(corpus, 'large.txt'), large);
    const digest = hash(large);
    const expectedRevision = 'd1_' + Buffer.from(digest, 'hex').toString('base64url');
    const blob = await scoped.putBlob(large, 'hotpath-large-object');
    assert.equal(blob.hash, 'sha256-' + digest);
    await scoped.createBranch({ operationId: 'hotpath-large-branch', workspaceId: 'ws', branchId: 'large',
      draftBasePaths: [], captureScopes: [], entries: [{ path: 'large.txt', ownerId: blob.ownerId,
        state: { kind: 'regular-file', objectHash: blob.hash, byteLength: blob.byteLength, mode: 0o644 } }] });
    const pin = await scoped.pinBranch({ operationId: 'hotpath-large-pin', branchId: 'large', revision: 0 });
    const sources = {
      live: address,
      pinned: { workspaceId: 'ws', pinId: String(pin.pinId), lane: 'background' },
    };
    const content = {};
    const memory = [{ phase: 'initialized', ...memorySample(pids) }];
    for (const [source, sourceAddress] of Object.entries(sources)) {
      const read = await runKernelCompute(scoped, { ...sourceAddress, operation: 'bytes', paths: ['large.txt'],
        byteOffset: 0, byteLength: 32 });
      assert.equal(read.status, 'ready', read.message);
      assert.equal(read.records[0].revision, expectedRevision);
      assert.deepEqual(Buffer.from(read.records[0].data.bytesBase64, 'base64'), large.subarray(0, 32));
      content[source] = await repeat(samples, async () => {
        const result = await runKernelCompute(scoped, { ...sourceAddress, operation: 'search', paths: ['large.txt'],
          query: 'absent-hotpath-marker', fixedStrings: true });
        assert.equal(result.status, 'empty', result.message);
        assert.equal(result.scannedFiles, 1);
        assert.equal(result.records.length, 0);
      });
    }
    const recipe = await scoped.computeGrammarRegister({ recipeId: '', grammarName: '', style: 'code',
      grammarPath: path.join(repo, 'packages/web/application-host/lib/structure/runtime/tree-sitter-typescript.wasm'),
      definitionQuery: queries.TYPESCRIPT_DEFINITION_QUERY, importQuery: queries.TYPESCRIPT_IMPORT_QUERY,
      literalCallQuery: queries.TYPESCRIPT_LITERAL_CALL_QUERY });
    const fileCount = 128;
    const files = [];
    const sourceDigest = createHash('sha256');
    let sourceBytes = 0;
    for (let i = 0; i < fileCount; i++) {
      const file = 'src/file' + String(i).padStart(5, '0') + '.ts';
      const text = "import { dependency } from './dependency';\nexport function fn_" + i
        + "() { return fetch('/api/" + i + "'); }\n";
      await fsp.writeFile(path.join(corpus, file), text);
      sourceDigest.update(file + '\0' + text); sourceBytes += Buffer.byteLength(text);
      files.push({ path: file, recipeId: String(recipe.recipeId), lines: [2] });
    }
    let resultSha256;
    const structure = await repeat(samples, async () => {
      const result = await runKernelCompute(scoped, { ...address, operation: 'structure',
        paths: ['src'], files, parseBudgetMs: 30000 });
      assert.equal(result.status, 'ready', result.message);
      assert.equal(result.scannedFiles, fileCount);
      const parts = result.records.filter(record => record.kind === 'structure-part')
        .map(record => ({ path: record.path, revision: record.revision, data: record.data }));
      const symbols = parts.filter(record => record.data.category === 'symbols')
        .flatMap(record => record.data.items.map(item => item.name)).sort();
      assert.deepEqual(symbols, Array.from({ length: fileCount }, (_, i) => 'fn_' + i).sort());
      assert.equal(parts.filter(record => record.data.category === 'imports').flatMap(record => record.data.items).length, fileCount);
      assert.equal(parts.filter(record => record.data.category === 'calls').flatMap(record => record.data.items).length, fileCount);
      const current = hash(JSON.stringify(parts));
      if (resultSha256 !== undefined) assert.equal(current, resultSha256);
      resultSha256 = current;
    });
    memory.push({ phase: 'after-hotpaths', ...memorySample(pids) });
    const report = { schema: 1, mode: 'compute-hotpaths', observedAt: new Date().toISOString(),
      platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model,
      checkoutBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      kernelPath, kernelSha256: hash(await fsp.readFile(kernelPath)), scriptSha256: hash(await fsp.readFile(script)),
      samples, largeFile: { utf8Bytes: large.length, sha256: digest }, content,
      structure: { files: fileCount, utf8Bytes: sourceBytes, sourceSha256: sourceDigest.digest('hex'),
        resultSha256, ...structure }, memory,
      limitations: ['First call does not flush the OS cache.', 'Timings include native capture/search/parse, IPC and Host projection, but exclude corpus creation and object upload.',
        'Both kernels use the same emitted Host adapters; rebuild Web before measuring a Host adapter change.',
        'The background lane intentionally reuses one worker to measure repeated same-recipe compilation across distinct files.',
        'Operation counts must be supported by the owning Rust tests/source; timing alone is not a compilation or hash counter.'] };
    await client.close(); client = undefined;
    await fsp.rm(temporary, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, JSON.stringify({ ...report, cleanupComplete: true }, null, 2) + '\n');
    console.log(output);
  } finally {
    await client?.close();
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function worker(input) {
  const { backend, corpus, count, webRoot, baselineRoot, samples } = input;
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-r6-measure-state-'));
  const hostRoot = backend === 'rust' ? path.join(webRoot, 'server') : baselineRoot;
  const [{ createWorkspaceContentSearch }, { createFsSearchRuntime }, { createTreeSitterStructureProvider }] = await Promise.all([
    load(hostRoot, 'lib/search/content.js'), load(hostRoot, 'lib/fs/search.js'), load(hostRoot, 'lib/structure/tree-sitter-provider.js'),
  ]);
  const file = 'src/file00000.ts';
  const text = await fsp.readFile(path.join(corpus, file), 'utf8');
  const documents = { inspectWorkspace: async () => ({ root: corpus }) };
  const pids = [process.pid];
  let client, scoped, compute, runKernelCompute, search, files, provider;
  let startupMs = 0;
  const memory = [];
  try {
    if (backend === 'rust') {
      const { createKernelClient } = await load(hostRoot, 'lib/kernel/kernel-client.js');
      const { createKernelComputeService } = await load(hostRoot, 'lib/kernel/compute-service.js');
      ({ runKernelCompute } = await load(hostRoot, 'lib/kernel/compute-runner.js'));
      const version = JSON.parse(await fsp.readFile(path.join(webRoot, 'package.json'), 'utf8')).version;
      client = createKernelClient({ hostId: 'r6-measure', storageRoot: state, buildVersion: version,
        kernelPath: path.join(webRoot, 'kernel', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'),
        allowCargoDevRunner: false, requireKernelManifest: true,
        spawnProcess: (...args) => { const child = spawn(...args); if (child.pid) pids.push(child.pid); return child; },
      });
      startupMs = (await timed(() => client.start())).ms;
      scoped = client.scoped(await client.issueGrant({ grantId: 'r6-measure-owner', owningWorkspace: 'ws', executionWorkspace: 'ws', pathScopes: [''], capabilities: ['storage.read', 'storage.write', 'storage.gc'] }));
      compute = createKernelComputeService({ client, resolveIdentity: async () => ({ workspaceId: 'ws', executionWorkspaceId: 'ws', canonicalRoot: corpus }) });
      search = createWorkspaceContentSearch({ documents, compute });
      files = createFsSearchRuntime({ compute });
      provider = createTreeSitterStructureProvider({ compute, parseBudgetMs: 10000 });
    } else {
      // Execute the package used by the accepted TS implementation, not an
      // unrelated rg on PATH. This package launches its own WASI runtime.
      const rg = path.join(repo, 'packages/web/node_modules/ripgrep/lib/rg.mjs');
      const baselineSpawn = (command, args, options) => command === 'rg'
        ? spawn(process.execPath, [rg, ...args], options) : spawn(command, args, options);
      search = createWorkspaceContentSearch({ documents, pathModule: path, spawn: baselineSpawn });
      files = createFsSearchRuntime({ fsPromises: fsp, path, spawn: baselineSpawn, resolveGitBinaryForSpawn: () => 'git' });
      provider = createTreeSitterStructureProvider({ parseBudgetMs: 10000 });
    }
    memory.push({ phase: 'initialized', ...memorySample(pids) });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const inventory = await repeat(samples, async () => {
      const found = await files.searchFilesystemFiles(corpus, { query: '', respectGitignore: false });
      assert.equal(found.length, count);
      assert.equal(found.enumerationStatus, 'complete');
    });
    const contentSearch = await repeat(samples, async () => {
      const found = await search.searchContent({ workspaceId: 'ws', query: 'r6_needle', fixedStrings: true });
      assert.equal(found.status, 'ready', found.message);
      assert.equal(found.hits.length, count);
    });
    const structure = await repeat(samples, async () => {
      let result;
      if (backend === 'rust') {
        result = await provider.analyzeFile({ workspaceId: 'ws', root: corpus, path: file, languageId: 'typescript', lane: 'foreground' });
      } else {
        const request = { path: file, languageId: 'typescript', text: await fsp.readFile(path.join(corpus, file), 'utf8'), revision: hash(text), lines: [] };
        // Pre-R5 exposes four operations over its shared parse cache.
        const outline = await provider.outline(request);
        const classify = await provider.classifyHits(request);
        const literalCalls = await provider.literalCalls(request);
        const imports = await provider.imports(request);
        result = { outline, classify, literalCalls, imports };
      }
      assert.equal(result.outline.status, 'ready', result.outline.message);
      assert.equal(result.outline.symbols[0].name, 'r6_needle');
    });
    await pause(20);
    delay.disable();
    const eventLoop = { resolutionMs: 10, p95Ms: rounded(delay.percentile(95) / 1e6), maxMs: rounded(delay.max / 1e6) };
    memory.push({ phase: 'after-query-workload', ...memorySample(pids) });
    const result = { backend, files: count, samples, startupMs: rounded(startupMs), inventory, contentSearch, structure, eventLoop, memory };
    if (backend === 'rust') {
      // Separate structural scaling corpus: N paths share one deduplicated body.
      const object = await scoped.putBlob(Buffer.from(text), 'scale-object');
      const stateFor = object => ({ kind: 'regular-file', objectHash: object.hash, byteLength: object.byteLength, mode: 0o644 });
      const branch = await timed(() => scoped.createBranch({ operationId: 'scale-create', workspaceId: 'ws', branchId: 'scale', draftBasePaths: [], captureScopes: [],
        entries: Array.from({ length: count }, (_, i) => ({ path: `src/file${String(i).padStart(5, '0')}.ts`, ownerId: object.ownerId, state: stateFor(object) })),
      }));
      const pin = await scoped.pinBranch({ operationId: 'scale-pin', branchId: 'scale', revision: 0 });
      const read = async () => {
        const r = await runKernelCompute(scoped, { workspaceId: 'ws', pinId: String(pin.pinId), lane: 'foreground', operation: 'read', paths: [file], files: [{ path: file }] });
        assert.equal(r.scannedFiles, 1);
        assert.equal(r.records.filter(record => record.kind === 'text').map(record => record.data.text).join(''), text);
      };
      const fixedRead = await repeat(samples, read);
      const writes = [], nodesAdded = [], walFileGrowth = [];
      for (let i = 0; i < samples; i++) {
        const body = await scoped.putBlob(Buffer.from(text + `// update ${i}\n`), 'scale-object-' + i);
        const before = await scoped.health();
        const changed = await timed(() => scoped.writeBranch({ operationId: 'scale-write-' + i, branchId: 'scale', expectedWriteRevision: i,
          changes: [{ path: file, ownerId: body.ownerId, state: stateFor(body) }],
        }));
        assert.equal(changed.result.status, 'committed');
        const after = await scoped.health();
        writes.push(changed.ms); nodesAdded.push(after.nodes - before.nodes);
        walFileGrowth.push((after.walBytes ?? 0) - (before.walBytes ?? 0));
      }
      await read(); // The existing pin must still name the original body.
      const backgroundObject = await scoped.putBlob(Buffer.from('r6_background_match\n'.repeat(160000)), 'background-object');
      await scoped.createBranch({ operationId: 'background-create', workspaceId: 'ws', branchId: 'background', draftBasePaths: [], captureScopes: [],
        entries: [{ path: 'large.txt', ownerId: backgroundObject.ownerId, state: stateFor(backgroundObject) }],
      });
      const backgroundPin = await scoped.pinBranch({ operationId: 'background-pin', branchId: 'background', revision: 0 });
      const abort = new AbortController();
      let entered, unblock;
      const started = new Promise(resolve => { entered = resolve; });
      const blocked = new Promise(resolve => { unblock = resolve; });
      const work = runKernelCompute(scoped, { workspaceId: 'ws', pinId: String(backgroundPin.pinId), lane: 'background', operation: 'search', query: 'r6_background_match', fixedStrings: true }, {
        signal: abort.signal, collect: false, onRecords: () => { entered(); return blocked; },
      });
      // Attach the rejection handler before delivering a cancellation.
      const outcome = work.then(() => null, error => error);
      await Promise.race([started, work.then(() => { throw new Error('Background query did not reach backpressure'); })]);
      await pause(80);
      let loaded, cancellationMs;
      try {
        const loadedDelay = monitorEventLoopDelay({ resolution: 10 }); loadedDelay.enable();
        loaded = await repeat(samples, read);
        await pause(20); loadedDelay.disable();
        result.loadedEventLoop = { p95Ms: rounded(loadedDelay.percentile(95) / 1e6), maxMs: rounded(loadedDelay.max / 1e6) };
        memory.push({ phase: 'background-backpressured', ...memorySample(pids) });
        const cancelling = performance.now(); abort.abort(); unblock();
        assert.equal((await outcome)?.name, 'AbortError');
        cancellationMs = rounded(performance.now() - cancelling);
      } finally { abort.abort(); unblock(); await outcome; }
      await scoped.unpinBranch({ operationId: 'background-unpin', branchId: 'background', pinId: String(backgroundPin.pinId) });
      await scoped.unpinBranch({ operationId: 'scale-unpin', branchId: 'scale', pinId: String(pin.pinId) });
      await scoped.deleteBranch({ operationId: 'background-delete', branchId: 'background' });
      await scoped.deleteBranch({ operationId: 'scale-delete', branchId: 'scale' });
      const health = await scoped.health({ deep: true }); assert.equal(health.integrity, 'ok');
      result.fixedState = { sharedBodyPaths: count, branchCreateMs: rounded(branch.ms), fixedRead, singlePathWrite: summary(writes),
        nodesAddedPerWrite: nodesAdded, walFileLengthDeltaBytes: walFileGrowth, foregroundUnderBackpressure: loaded, cancelToTerminalAndReleaseMs: cancellationMs, integrity: health.integrity };
      memory.push({ phase: 'after-cancel-and-release', ...memorySample(pids) });
    }
    return result;
  } finally {
    try { await provider?.dispose?.(); await compute?.dispose(); } finally { await client?.close(); }
    await fsp.rm(state, { recursive: true, force: true });
  }
}

async function emitBaseline(directory, ref) {
  const archive = execFileSync('git', ['archive', '--format=tar', ref, 'packages/web/application-host'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const tar = path.join(directory, 'baseline.tar'); await fsp.writeFile(tar, archive);
  execFileSync('tar', ['-xf', tar, '-C', directory], { windowsHide: true });
  await fsp.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await fsp.symlink(path.join(repo, 'packages/web/node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const ts = (await import('typescript')).default;
  const root = path.join(directory, 'packages/web/application-host');
  const emit = async dir => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await emit(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test')) {
        const source = await fsp.readFile(full, 'utf8');
        const { outputText } = ts.transpileModule(source, { fileName: full, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } });
        await fsp.writeFile(full.slice(0, -3) + '.js', outputText);
      }
    }
  };
  await emit(root); return root;
}

async function runWorker(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--worker', JSON.stringify(input)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', s => { out += s; }); child.stderr.on('data', s => { err += s; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`Measurement ${input.backend}/${input.count} failed: ${err}\n${out}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
    });
  });
}

if (process.argv[2] === '--compute-hotpaths') {
  const output = path.resolve(process.argv[3] ?? path.join(repo, 'artifacts/compute-hotpaths.json'));
  const kernelPath = path.resolve(process.argv[4] ?? path.join(repo, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'));
  const webRoot = path.resolve(process.argv[5] ?? path.join(repo, 'packages/web'));
  await computeHotpaths(output, kernelPath, webRoot);
} else if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(JSON.parse(process.argv[3]))));
} else {
  const output = path.resolve(process.argv[2] ?? path.join(repo, 'artifacts/r6-performance.json'));
  const webRoot = path.resolve(process.argv[3] ?? path.join(repo, 'packages/web'));
  const baselineRef = execFileSync('git', ['rev-parse', 'b621db6a^{commit}'], { cwd: repo, encoding: 'utf8' }).trim();
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-r6-comparison-'));
  try {
    const baselineRoot = await emitBaseline(temporary, baselineRef);
    const runs = [], corpora = [];
    for (const count of [128, 1024, 4096]) {
      const corpus = path.join(temporary, 'corpus-' + count); await fsp.mkdir(path.join(corpus, 'src'), { recursive: true });
      const digest = createHash('sha256'); let bytes = 0;
      for (let i = 0; i < count; i++) {
        const relative = `src/file${String(i).padStart(5, '0')}.ts`;
        const body = 'export function r6_needle() { return "measured-value"; }\n' + `// file ${i}\n` + '// stable measurement payload 中文\n'.repeat(24);
        digest.update(relative + '\0' + body); bytes += Buffer.byteLength(body);
        await fsp.writeFile(path.join(corpus, relative), body);
      }
      corpora.push({ files: count, utf8Bytes: bytes, sha256: digest.digest('hex') });
      // Alternate order. The operating-system file cache is not forcibly reset.
      for (const backend of count === 1024 ? ['rust', 'typescript'] : ['typescript', 'rust']) {
        console.error(`[r6] measuring ${backend}, ${count} files`);
        runs.push(await runWorker({ backend, corpus, count, webRoot, baselineRoot, samples: 8 }));
      }
    }
    const manifest = JSON.parse(await fsp.readFile(path.join(webRoot, 'kernel/manifest.json'), 'utf8'));
    const report = { schema: 1, observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), baselineCommit: baselineRef,
      checkoutBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), kernelSha256: manifest.sha256,
      scriptSha256: hash(await fsp.readFile(script)), corpora, runs, cleanupComplete: true,
      limitations: ['First call means a fresh process/runtime, not a flushed OS disk cache.', 'Pre-R5 source is emitted in a temporary tree and uses the current installed dependencies; rg is the pinned npm WASI launcher.', 'Warm TS structure can reuse its parse cache; native file analysis captures and parses the file again. These are product-path costs, not a language microbenchmark.', 'Memory entries are synchronous phase samples, not continuous peak RSS. Transient baseline rg processes are not included, so cross-backend total-memory comparisons are invalid.', 'Pi/model/network work is absent; this is not a total interactive-session memory benchmark.', 'WAL file length deltas and new trie-node counts are not physical disk write amplification.'] };
    await fsp.rm(temporary, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(output);
  } catch (error) { await fsp.rm(temporary, { recursive: true, force: true }); throw error; }
}
