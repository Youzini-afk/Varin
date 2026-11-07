import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptImageRelease, createImageRegistry, dockerCommand, imageVersionParts, resolveRuntimeBase } from './docker-release.mjs';
import { acceptCommitPublication } from './docker-commit.mjs';

const repository = 'Youzini-afk/Varin';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const names = { slim_base: 'varin-runtime-slim', toolbelt_base: 'varin-runtime-toolbelt',
  standard_app: 'varin', toolbelt_app: 'varin-toolbelt' };
const baseTargets = { slim_base: 'slim', toolbelt_base: 'toolbelt' };
const baseForApp = { standard_app: 'slim_base', toolbelt_app: 'toolbelt_base' };

export function containerBuildConfig(input) {
  if (!['check', 'release', 'commit'].includes(input.publication)) throw new Error('Unknown container publication channel');
  for (const key of ['sourceSha', 'toolingSha']) if (!shaPattern.test(input[key] ?? '')) throw new Error(`Invalid ${key}`);
  imageVersionParts(input.version);
  for (const key of ['runId', 'runAttempt']) if (!/^[1-9]\d*$/.test(String(input[key] ?? ''))) throw new Error(`Invalid ${key}`);
  if (input.publication !== 'check') {
    if (input.repository?.toLowerCase() !== repository.toLowerCase()) throw new Error('Untrusted container publication repository');
    if (input.publication === 'release') {
      if (input.sourceSha !== input.toolingSha || input.sourceSha !== input.githubSha) throw new Error('Release source and tooling must match the selected tag');
      acceptImageRelease({ eventName: input.eventName, ref: input.ref, sha: input.sourceSha, version: input.version });
    } else {
      if (input.toolingSha !== input.githubSha) throw new Error('Commit tooling must match the dispatch SHA');
      acceptCommitPublication({ eventName: input.eventName, ref: input.ref, repository: input.repository,
        toolingSha: input.toolingSha, sourceSha: input.sourceSha, version: input.version });
    }
  }
  if (input.localCache && input.publication !== 'check') throw new Error('Disposable cache is only available to validation');
  const overrides = { slim_base: input.slimBase || '', toolbelt_base: input.toolbeltBase || '' };
  if (input.publication !== 'release' && Object.values(overrides).some(Boolean)) throw new Error('Base overrides belong only to explicit releases');
  const toolbelt = input.publication !== 'check' || input.toolbelt === true;
  const platforms = input.publication !== 'check' || input.multiPlatform === true ? ['linux/amd64', 'linux/arm64'] : ['linux/amd64'];
  return { ...input, runId: String(input.runId), runAttempt: String(input.runAttempt), toolbelt, platforms, overrides,
    localCache: input.localCache === true,
    registry: input.publication === 'check' ? 'localhost:5000' : 'ghcr.io/youzini-afk',
    sourceDirectory: path.resolve(input.sourceDirectory), outputDirectory: path.resolve(input.outputDirectory),
    tag: `candidate-${input.runId}-${input.runAttempt}` };
}

function labels(config, base) {
  return { 'org.opencontainers.image.source': `https://github.com/${repository}`,
    'org.opencontainers.image.revision': config.sourceSha, 'org.opencontainers.image.version': config.version,
    'io.varin.publication.kind': config.publication, 'io.varin.build.run_id': config.runId,
    'io.varin.build.run_attempt': config.runAttempt, 'io.varin.build.tooling_sha': config.toolingSha,
    ...(base ? { 'io.varin.image.base': base } : {}) };
}

function cache(config, phase) {
  const name = phase === 'bases' ? names.toolbelt_base : names.standard_app;
  // The optional benchmark roundtrip is confined to its disposable loopback
  // registry. It cannot select an arbitrary destination or poison release cache.
  const registry = config.localCache ? 'localhost:5000' : 'ghcr.io/youzini-afk';
  const ref = `${registry}/${name}:buildcache-v2`;
  // Only admitted release/main workflows update the shared registry cache.
  // Ordinary PR validation reads public layers, with no registry credentials.
  const writable = config.publication !== 'check' || config.localCache;
  return { from: [`type=registry,ref=${ref}`, ...(phase === 'bases'
    ? [`type=registry,ref=${registry}/varin-runtime-slim:buildcache-v2`] : [])], to: !writable ? []
    : [`type=registry,ref=${ref},mode=max,oci-mediatypes=true,image-manifest=true${config.localCache ? '' : ',ignore-error=true'}`] };
}

export function containerBakePlan(config, phase, bases = {}) {
  if (!['bases', 'applications'].includes(phase)) throw new Error('Unknown container build phase');
  const targets = {}, caching = cache(config, phase);
  const keys = phase === 'bases' ? Object.keys(baseTargets) : Object.keys(baseForApp);
  for (const key of keys) {
    if (!config.toolbelt && key.startsWith('toolbelt_')) continue;
    if (phase === 'bases' && config.overrides[key]) continue;
    const base = phase === 'applications' ? bases[baseForApp[key]] : null;
    if (phase === 'applications' && !/^.+@sha256:[a-f0-9]{64}$/.test(base ?? '')) throw new Error(`Missing immutable base for ${key}`);
    targets[key] = { context: config.sourceDirectory, dockerfile: phase === 'bases' ? 'Dockerfile.base' : 'Dockerfile',
      ...(phase === 'bases' ? { target: baseTargets[key] } : {}),
      platforms: config.platforms, pull: true, tags: [`${config.registry}/${names[key]}:${config.tag}`],
      labels: labels(config, base), attest: ['type=provenance,mode=max', 'type=sbom'],
      output: ['type=registry'], 'cache-from': caching.from,
      ...(base ? { args: { RUNTIME_BASE_IMAGE: base, VARIN_SOURCE_REVISION: config.sourceSha } } : {}) };
  }
  // Export once per shared graph, not once for each final variant. The toolbelt
  // base includes slim; either app includes all architecture-specific builders.
  const exporter = phase === 'bases' && targets.toolbelt_base ? 'toolbelt_base' : Object.keys(targets)[0];
  if (exporter && caching.to.length) targets[exporter]['cache-to'] = phase === 'bases' && exporter === 'slim_base'
    ? caching.to.map(value => value.replace('/varin-runtime-toolbelt:', '/varin-runtime-slim:')) : caching.to;
  return { group: { default: { targets: Object.keys(targets) } }, target: targets };
}

export function builtImageReferences(config, plan, metadata) {
  if (!metadata || typeof metadata !== 'object') throw new Error('Missing build metadata');
  return Object.fromEntries(Object.keys(plan.target).map(key => {
    const digest = metadata[key]?.['containerimage.digest'];
    if (!digestPattern.test(digest ?? '')) throw new Error(`Missing immutable build output: ${key}`);
    return [key, `${config.registry}/${names[key]}@${digest}`];
  }));
}

export function buildLogMetrics(log) {
  const ids = expression => new Set([...log.matchAll(expression)].map(match => match[1]));
  const exports = ids(/^#(\d+) (?:\[[^\]]+\] )?exporting cache to registry$/gm);
  const cached = ids(/^#(\d+) CACHED\s*$/gm);
  const completed = ids(/^#(\d+) DONE(?: [\d.]+s)?\s*$/gm);
  // Plain progress reports a lazy remote cache hit as layer extraction followed
  // by DONE, not CACHED. Timestamped process output proves that RUN executed;
  // downloads/extraction are un-timestamped BuildKit status messages instead.
  // These Rust RUNs use `set -eux`, so a real cook/build cannot be silent.
  const executed = ids(/^#(\d+) [\d.]+ .+$/gm);
  const runVertices = ids(/^#(\d+) \[[^\]]+\] RUN /gm);
  const restored = ids(/^#(\d+) extracting sha256:[a-f0-9]{64}.*\bdone$/gm);
  for (const id of restored) if (runVertices.has(id) && completed.has(id) && !executed.has(id)) cached.add(id);
  for (const id of executed) cached.delete(id);
  const vertices = stage => ids(new RegExp(`^#(\\d+) \\[[^\\]]*${stage}[^\\]]*\\] RUN `, 'gm'));
  const cooks = vertices('kernel-dependencies'), builds = vertices('kernel-builder');
  return { cachedVertices: cached.size,
    dependencyCookCacheHits: [...cooks].filter(id => cached.has(id)).length,
    dependencyCookExecutions: [...cooks].filter(id => executed.has(id)).length,
    dependencyCookUnknown: [...cooks].filter(id => !cached.has(id) && !executed.has(id)).length,
    kernelBuildExecutions: [...builds].filter(id => executed.has(id)).length,
    rustReleaseCompilations: (log.match(/Finished `release` profile/g) ?? []).length,
    cacheExportSeconds: [...log.matchAll(/#(\d+) DONE ([\d.]+)s/g)].reduce((total, match) =>
      exports.has(match[1]) ? total + Number(match[2]) : total, 0) };
}

export async function buildContainerImages(config, { run, resolveBase, now = () => Date.now() }) {
  fs.mkdirSync(config.outputDirectory, { recursive: true });
  fs.rmSync(path.join(config.outputDirectory, 'result.json'), { force: true });
  const result = { sourceSha: config.sourceSha, toolingSha: config.toolingSha, platforms: config.platforms, images: {}, phases: [] };
  for (const [key, override] of Object.entries(config.overrides)) {
    if (override) result.images[key] = await resolveBase(override, baseTargets[key]);
  }
  for (const phase of ['bases', 'applications']) {
    const plan = containerBakePlan(config, phase, result.images);
    if (!Object.keys(plan.target).length) continue;
    const planPath = path.join(config.outputDirectory, `${phase}.bake.json`);
    const metadataPath = path.join(config.outputDirectory, `${phase}.metadata.json`);
    const logPath = path.join(config.outputDirectory, `${phase}.log`);
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    // Stale output from a previous failed invocation must never become evidence.
    fs.rmSync(metadataPath, { force: true });
    const started = now();
    // Reviewed tooling and historical source are sibling checkouts. Bake's
    // filesystem entitlement is intentionally limited to that exact context,
    // rather than disabling its guard or silently reading the tooling checkout.
    await run(['buildx', 'bake', `--allow=fs.read=${config.sourceDirectory}`,
      '--file', planPath, '--progress=plain', '--metadata-file', metadataPath], { logPath });
    const images = builtImageReferences(config, plan, JSON.parse(fs.readFileSync(metadataPath, 'utf8')));
    Object.assign(result.images, images);
    result.phases.push({ name: phase, seconds: (now() - started) / 1000,
      ...buildLogMetrics(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '') });
    // Validate role, variant and both platforms before consuming an override or
    // a freshly produced base in a privileged publication build.
    if (phase === 'bases' && config.publication !== 'check') {
      for (const [key, image] of Object.entries(images)) result.images[key] = await resolveBase(image, baseTargets[key]);
    }
  }
  fs.writeFileSync(path.join(config.outputDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const gitHead = directory => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

function environmentConfig(env) {
  const sourceDirectory = path.resolve(env.CONTAINER_SOURCE_DIR || '.'), toolingDirectory = process.cwd();
  const version = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'package.json'), 'utf8')).version;
  if (env.CONTAINER_SOURCE_VERSION && env.CONTAINER_SOURCE_VERSION !== version) throw new Error('Accepted source version changed');
  if (gitHead(sourceDirectory) !== env.CONTAINER_SOURCE_SHA || gitHead(toolingDirectory) !== env.CONTAINER_TOOLING_SHA) {
    throw new Error('Source or tooling checkout does not match its admitted SHA');
  }
  return containerBuildConfig({ publication: env.CONTAINER_PUBLICATION, sourceSha: env.CONTAINER_SOURCE_SHA,
    toolingSha: env.CONTAINER_TOOLING_SHA, version, runId: env.GITHUB_RUN_ID || '1', runAttempt: env.GITHUB_RUN_ATTEMPT || '1',
    repository: env.GITHUB_REPOSITORY, githubSha: env.GITHUB_SHA, ref: env.GITHUB_REF, eventName: env.GITHUB_EVENT_NAME,
    sourceDirectory, outputDirectory: env.CONTAINER_OUTPUT_DIR || path.resolve('artifacts/container-build'),
    localCache: env.CONTAINER_LOCAL_CACHE === 'true',
    toolbelt: env.CONTAINER_TOOLBELT === 'true', multiPlatform: env.CONTAINER_MULTI_PLATFORM === 'true',
    slimBase: env.CONTAINER_SLIM_BASE, toolbeltBase: env.CONTAINER_TOOLBELT_BASE });
}

async function runDocker(args, { logPath }) {
  const log = fs.createWriteStream(logPath);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
      child.on('error', reject);
      child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Docker build failed (${signal ?? code})`)));
    });
  } finally { await new Promise(resolve => log.end(resolve)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!['validate', 'build'].includes(command)) throw new Error('Usage: build-container-images.mjs validate|build');
  const config = environmentConfig(process.env);
  if (command === 'validate') {
    // Run before registry login. Invalid production locks fail cheaply, while the
    // independent complete source-quality workflow still owns qualification.
    execFileSync(process.execPath, [path.join(config.sourceDirectory, 'scripts/build-cloud-runtime.mjs'), '--check-lock'],
      { cwd: config.sourceDirectory, stdio: 'inherit' });
    console.log(`Accepted ${config.publication} container inputs at ${config.sourceSha}`);
  } else {
    const registry = createImageRegistry(dockerCommand());
    const result = await buildContainerImages(config, { run: runDocker,
      resolveBase: (reference, variant) => resolveRuntimeBase(reference, variant, registry) });
    if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result.images)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Container build\n\nSource: ${result.sourceSha}\n\n${result.phases.map(phase =>
        `- ${phase.name}: ${phase.seconds.toFixed(1)}s; ${phase.cachedVertices} cached vertices; ${phase.rustReleaseCompilations} Rust release compilation completions`).join('\n')}\n`);
  }
}
