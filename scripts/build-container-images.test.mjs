import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildContainerImages, buildLogMetrics, builtImageReferences, containerBakePlan, containerBuildConfig } from './build-container-images.mjs';

const sha = 'a'.repeat(40), tooling = 'b'.repeat(40), digest = value => `sha256:${value.repeat(64)}`;
const input = { publication: 'commit', sourceSha: sha, toolingSha: tooling, version: '0.9.39', runId: '12', runAttempt: '1',
  repository: 'Youzini-afk/Varin', githubSha: tooling, ref: 'refs/heads/main', eventName: 'workflow_dispatch',
  sourceDirectory: '/source', outputDirectory: '/output' };
const bases = { slim_base: `ghcr.io/youzini-afk/varin-runtime-slim@${digest('1')}`,
  toolbelt_base: `ghcr.io/youzini-afk/varin-runtime-toolbelt@${digest('2')}` };

test('privileged build input rejects untrusted channels, refs, identities and override paths before building', () => {
  for (const patch of [{ publication: 'push' }, { sourceSha: 'main' }, { toolingSha: 'HEAD' }, { repository: 'outside/Varin' },
    { ref: 'refs/heads/feature' }, { eventName: 'pull_request' }, { githubSha: sha }, { runId: '12\nlatest' },
    { runAttempt: '0' }, { localCache: true }, { slimBase: 'arbitrary:latest' }, { version: '0.9.39\nOTHER=x' }]) {
    assert.throws(() => containerBuildConfig({ ...input, ...patch }), undefined, JSON.stringify(patch));
  }
  const release = { ...input, publication: 'release', sourceSha: tooling, ref: 'refs/tags/v0.9.39' };
  assert.doesNotThrow(() => containerBuildConfig(release));
  for (const patch of [{ ref: 'refs/heads/main' }, { sourceSha: sha }, { version: '0.9.40' }]) {
    assert.throws(() => containerBuildConfig({ ...release, ...patch }));
  }
});

test('shared bake graph retains both platforms, exact source, attestations and distinct digest-bound variants', () => {
  const config = containerBuildConfig(input), runtime = containerBakePlan(config, 'bases');
  const apps = containerBakePlan(config, 'applications', bases);
  assert.deepEqual(runtime.group.default.targets, ['slim_base', 'toolbelt_base']);
  assert.deepEqual(apps.group.default.targets, ['standard_app', 'toolbelt_app']);
  for (const plan of [runtime, apps]) for (const target of Object.values(plan.target)) {
    assert.equal(target.context, '/source');
    assert.deepEqual(target.platforms, ['linux/amd64', 'linux/arm64']);
    assert.deepEqual(target.attest, ['type=provenance,mode=max', 'type=sbom']);
    assert.deepEqual(target.output, ['type=registry']);
    assert.ok(target.tags.every(tag => tag.endsWith(':candidate-12-1')));
    assert.equal(target.labels['org.opencontainers.image.revision'], sha);
    assert.equal(target.labels['io.varin.build.tooling_sha'], tooling);
    assert.equal(target.labels['io.varin.publication.kind'], 'commit');
  }
  for (const [app, base] of [['standard_app', 'slim_base'], ['toolbelt_app', 'toolbelt_base']]) {
    assert.equal(apps.target[app].args.RUNTIME_BASE_IMAGE, bases[base]);
    assert.equal(apps.target[app].labels['io.varin.image.base'], bases[base]);
    assert.equal(apps.target[app].args.VARIN_SOURCE_REVISION, sha);
  }
  assert.equal(runtime.target.slim_base.target, 'slim');
  assert.equal(runtime.target.toolbelt_base.target, 'toolbelt');
  for (const plan of [runtime, apps]) {
    const exporters = Object.values(plan.target).filter(target => target['cache-to']);
    assert.equal(exporters.length, 1, 'Export the common intermediate graph only once');
    assert.ok(exporters[0]['cache-to'][0].startsWith('type=registry,'));
    assert.ok(exporters[0]['cache-to'][0].includes('mode=max'));
  }
});

test('read-only validation can only push loopback candidates and cannot export privileged caches', () => {
  for (const toolbelt of [false, true]) for (const multiPlatform of [false, true]) {
    const config = containerBuildConfig({ ...input, publication: 'check', toolbelt, multiPlatform });
    const basePlan = containerBakePlan(config, 'bases');
    for (const plan of [basePlan, containerBakePlan(config, 'applications', bases)]) {
      assert.equal(plan.group.default.targets.length, toolbelt ? 2 : 1);
      for (const target of Object.values(plan.target)) {
        assert.ok(target.tags.every(tag => tag.startsWith('localhost:5000/')));
        assert.equal(target['cache-to'], undefined);
        assert.equal(target.platforms.length, multiPlatform ? 2 : 1);
      }
    }
  }
});

test('base overrides skip only their own build and retain the exact resolved companion reference', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-container-plan-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const config = containerBuildConfig({ ...input, publication: 'release', sourceSha: tooling, ref: 'refs/tags/v0.9.39',
    outputDirectory, slimBase: 'registry.example/reused-slim:chosen', toolbeltBase: 'registry.example/reused-toolbelt:chosen' });
  const calls = [], resolved = [];
  const result = await buildContainerImages(config, {
    resolveBase(reference, variant) {
      resolved.push([reference, variant]);
      return `registry.example/reused-${variant}@${digest(variant === 'slim' ? '1' : '2')}`;
    },
    async run(args) {
      const plan = JSON.parse(fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
      calls.push(plan);
      assert.equal(plan.target.standard_app.args.RUNTIME_BASE_IMAGE, `registry.example/reused-slim@${digest('1')}`);
      assert.equal(plan.target.toolbelt_app.args.RUNTIME_BASE_IMAGE, `registry.example/reused-toolbelt@${digest('2')}`);
      fs.writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify({
        standard_app: { 'containerimage.digest': digest('3') }, toolbelt_app: { 'containerimage.digest': digest('4') } }));
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(resolved.map(call => call[1]), ['slim', 'toolbelt']);
  assert.equal(result.images.slim_base, `registry.example/reused-slim@${digest('1')}`);
});

test('orchestration validates metadata and bases before downstream builds and never accepts stale partial outputs', async t => {
  for (const failure of ['build', 'metadata', 'base']) {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-container-failure-'));
    t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
    const config = containerBuildConfig({ ...input, outputDirectory }), calls = [];
    fs.writeFileSync(path.join(outputDirectory, 'result.json'), 'stale result');
    fs.writeFileSync(path.join(outputDirectory, 'bases.metadata.json'), JSON.stringify({
      slim_base: { 'containerimage.digest': digest('1') }, toolbelt_base: { 'containerimage.digest': digest('2') } }));
    await assert.rejects(buildContainerImages(config, {
      async run(args) {
        calls.push(args);
        const metadata = args[args.indexOf('--metadata-file') + 1];
        assert.ok(!fs.existsSync(metadata));
        if (failure === 'build') throw new Error('Interrupted');
        fs.writeFileSync(metadata, JSON.stringify(failure === 'metadata' ? {} : {
          slim_base: { 'containerimage.digest': digest('1') }, toolbelt_base: { 'containerimage.digest': digest('2') } }));
      },
      resolveBase() { throw new Error('Wrong base architecture'); },
    }));
    assert.equal(calls.length, 1);
    assert.ok(!fs.existsSync(path.join(outputDirectory, 'result.json')));
  }
});

test('successful orchestration passes only observed base digests into the shared application graph', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-container-success-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const config = containerBuildConfig({ ...input, outputDirectory }), plans = [], verified = [];
  let clock = 0;
  const result = await buildContainerImages(config, {
    now: () => (clock += 1000),
    resolveBase(reference, variant) { verified.push([reference, variant]); return reference; },
    async run(args, { logPath }) {
      assert.ok(args.includes('--allow=fs.read=/source'));
      assert.ok(!args.some(value => value.includes('fs.read=*')));
      const plan = JSON.parse(fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
      plans.push(plan);
      fs.writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify(Object.fromEntries(
        Object.keys(plan.target).map((key, index) => [key, { 'containerimage.digest': digest(String(index + plans.length)) }]))));
      fs.writeFileSync(logPath, '#12 CACHED\n#13 CACHED\n');
    },
  });
  assert.equal(plans.length, 2);
  assert.equal(verified.length, 2);
  assert.equal(plans[1].target.standard_app.args.RUNTIME_BASE_IMAGE, result.images.slim_base);
  assert.equal(plans[1].target.toolbelt_app.args.RUNTIME_BASE_IMAGE, result.images.toolbelt_base);
  assert.deepEqual(Object.keys(result.images).sort(), ['slim_base', 'standard_app', 'toolbelt_app', 'toolbelt_base']);
  assert.ok(result.phases.every(phase => phase.seconds === 1 && phase.cachedVertices === 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDirectory, 'result.json'), 'utf8')), result);
});

test('metadata cannot substitute a mutable tag or a missing target for an immutable digest', () => {
  const config = containerBuildConfig(input), plan = containerBakePlan(config, 'bases');
  for (const digestValue of ['latest', `sha256:${'x'.repeat(64)}`, undefined]) {
    assert.throws(() => builtImageReferences(config, plan, { slim_base: { 'containerimage.digest': digestValue } }));
  }
  assert.deepEqual(buildLogMetrics('#1 CACHED\n#2 12.0 Finished `release` profile [optimized]\n'), {
    cachedVertices: 1, dependencyCookCacheHits: 0, dependencyCookExecutions: 0, dependencyCookUnknown: 0, kernelBuildExecutions: 0, rustReleaseCompilations: 1, cacheExportSeconds: 0 });
});


test('cache roundtrip exports only fixed loopback refs and never silently ignores failures', () => {
  const config = containerBuildConfig({ ...input, publication: 'check', localCache: true, toolbelt: true });
  for (const plan of [containerBakePlan(config, 'bases'), containerBakePlan(config, 'applications', bases)]) {
    for (const target of Object.values(plan.target)) {
      for (const cache of [...target['cache-from'], ...(target['cache-to'] || [])]) {
        assert.ok(cache.includes('ref=localhost:5000/'));
        assert.ok(!cache.includes('ghcr.io'));
        assert.ok(!cache.includes('ignore-error=true'));
      }
    }
    assert.equal(Object.values(plan.target).filter(target => target['cache-to']).length, 1);
  }
});

test('cache metrics distinguish restored dependency cooks from required source recompilation', () => {
  const result = buildLogMetrics([
    '#11 [standard_app linux/amd64 kernel-dependencies 3/3] RUN set -eux; cargo chef cook',
    '#11 CACHED',
    '#12 [standard_app linux/arm64 kernel-dependencies 3/3] RUN set -eux; cargo chef cook',
    '#12 CACHED',
    '#13 [standard_app linux/amd64 kernel-builder 3/3] RUN set -eux; cargo build',
    '#13 1.0 Finished `release` profile [optimized]',
    '#13 DONE 1.1s',
    '#14 [standard_app linux/arm64 kernel-builder 3/3] RUN set -eux; cargo build',
    '#14 2.0 Finished `release` profile [optimized]',
    '#14 DONE 2.1s',
    '#15 [standard_app] exporting cache to registry',
    '#15 [standard_app] exporting cache to registry',
    '#15 DONE 2.5s',
  ].join('\n'));
  assert.deepEqual(result, { cachedVertices: 2, dependencyCookCacheHits: 2, dependencyCookExecutions: 0, dependencyCookUnknown: 0,
    kernelBuildExecutions: 2, rustReleaseCompilations: 2, cacheExportSeconds: 2.5 });
});


test('lazy remote cache extraction is not a cook execution, and ambiguous progress fails closed', () => {
  const sha = 'f'.repeat(64);
  const result = buildLogMetrics([
    '#56 [toolbelt_app linux/amd64->arm64 kernel-dependencies 3/3] RUN set -eux; cargo chef cook',
    `#56 sha256:${sha} 446.82MB / 446.82MB 4.3s done`,
    `#56 extracting sha256:${sha} 13.3s done`,
    '#56 DONE 17.8s',
    '#57 [toolbelt_app linux/amd64 kernel-dependencies 3/3] RUN set -eux; cargo chef cook',
    `#57 extracting sha256:${sha} 14.0s done`,
    '#57 DONE 18.4s',
    '#62 [toolbelt_app linux/amd64->arm64 kernel-builder 3/3] RUN set -eux; cargo build',
    '#62 0.066 + kernel_arch=arm64',
    '#62 582.1 Finished `release` profile [optimized] target(s) in 9m 41s',
    '#62 DONE 583.0s',
    '#64 [toolbelt_app linux/amd64 kernel-builder 3/3] RUN set -eux; cargo build',
    '#64 0.066 + kernel_arch=x64',
    '#64 545.7 Finished `release` profile [optimized] target(s) in 9m 04s',
    '#64 DONE 546.0s',
  ].join('\n'));
  assert.equal(result.dependencyCookCacheHits, 2);
  assert.equal(result.dependencyCookExecutions, 0);
  assert.equal(result.dependencyCookUnknown, 0);
  assert.equal(result.kernelBuildExecutions, 2);
  assert.equal(result.rustReleaseCompilations, 2);
  const ambiguous = buildLogMetrics('#1 [standard_app kernel-dependencies 3/3] RUN set -eux; cargo chef cook\n#1 DONE 1.0s');
  assert.equal(ambiguous.dependencyCookCacheHits, 0);
  assert.equal(ambiguous.dependencyCookUnknown, 1);
  const executed = buildLogMetrics(`#1 [standard_app kernel-dependencies 3/3] RUN set -eux; cargo chef cook\n#1 extracting sha256:${sha} done\n#1 0.1 + cargo chef cook\n#1 DONE 1.0s`);
  assert.equal(executed.dependencyCookCacheHits, 0);
  assert.equal(executed.dependencyCookExecutions, 1);
});
