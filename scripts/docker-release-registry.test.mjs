import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acceptImageRelease, createImageRegistry, dockerCommand, imagePromotionPlan,
  promoteImages, resolveRuntimeBase, verifyImage, writeAnonymousDockerConfig } from './docker-release.mjs';
import { promoteCommitImages } from './docker-commit.mjs';

const registryAddress = process.env.VARIN_TEST_IMAGE_REGISTRY;
test('real loopback registry preserves indexes, exact-tag preflight, variant aliases and promotion retries', {
  skip: !registryAddress && 'Set VARIN_TEST_IMAGE_REGISTRY to the disposable loopback registry; container CI requires this test',
  timeout: 180_000,
}, t => {
  // Never turn this fixture into publication against GHCR or another remote.
  assert.match(registryAddress, /^(?:localhost|127\.0\.0\.1):\d+$/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-release-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'anonymous'); fs.mkdirSync(config);
  writeAnonymousDockerConfig(config);
  const docker = dockerCommand(config), calls = [];
  const registry = createImageRegistry((args, options) => {
    assert.ok(args[0] === 'pull' || ['inspect', 'create'].includes(args[2]), 'Unexpected registry operation');
    const references = args[0] === 'pull' ? [args.at(-1)] : args[2] === 'inspect' ? [args[3]] : [args[args.indexOf('--tag') + 1], args.at(-1)];
    assert.ok(references.every(ref => ref.startsWith(`${registryAddress}/`)), 'Fixture attempted a non-loopback registry reference');
    calls.push({ args, options });
    return docker(args, options);
  });
  const namespace = `${registryAddress}/varin-release-fixture-${process.pid}-${Date.now()}`;
  const dockerfile = path.join(root, 'Dockerfile');
  const commitSource = 'c'.repeat(40), commitTooling = 'd'.repeat(40), productionPrefix = 'ghcr.io/youzini-afk/';
  fs.writeFileSync(dockerfile, `FROM scratch
ARG ROLE
ARG VARIANT
ARG BASE_REFERENCE
LABEL io.varin.image.role=$ROLE io.varin.image.variant=$VARIANT io.varin.image.base=$BASE_REFERENCE
LABEL org.opencontainers.image.source="https://github.com/Youzini-afk/Varin" org.opencontainers.image.revision="${commitSource}" org.opencontainers.image.version="0.9.38"
LABEL io.varin.publication.kind="commit" io.varin.build.run_id="8" io.varin.build.run_attempt="1" io.varin.build.tooling_sha="${commitTooling}"
ENV VARIN_IMAGE_VARIANT=$VARIANT
`);
  const sources = {};
  for (const [name, role, variant] of [
    ['slimBase', 'runtime-base', 'slim'], ['toolbeltBase', 'runtime-base', 'toolbelt'],
    ['standardApp', 'application', 'slim'], ['toolbeltApp', 'application', 'toolbelt'],
  ]) {
    const tag = `${namespace}/source-${name.toLowerCase()}:candidate`;
    // Metadata-only indexes: no target-platform commands, QEMU, or application
    // startup claims. The existing real app smokes retain that separate proof.
    const companion = role === 'application' ? `${productionPrefix}${variant === 'slim' ? 'varin-runtime-slim' : 'varin-runtime-toolbelt'}@${sources[variant === 'slim' ? 'slimBase' : 'toolbeltBase'].split('@')[1]}` : '';
    execFileSync('docker', ['buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--provenance=false', '--sbom=false',
      '--build-arg', `ROLE=${role}`, '--build-arg', `VARIANT=${variant}`, '--build-arg', `BASE_REFERENCE=${companion}`, '--push', '--tag', tag, root],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    const digest = registry.manifest(tag).digest;
    sources[name] = `${tag.split(':').slice(0, -1).join(':')}@${digest}`;
    verifyImage(sources[name], { role, variant }, registry);
    if (role === 'runtime-base') assert.equal(resolveRuntimeBase(tag, variant, registry), sources[name]);
  }
  const candidate = acceptImageRelease({ eventName: 'push', ref: 'refs/tags/v0.9.39', version: '0.9.39', sha: 'a'.repeat(40) });
  const localPlan = scope => imagePromotionPlan(candidate, sources, [candidate.ref]).map(artifact => {
    const local = ref => ref.replace('ghcr.io/youzini-afk/', `${namespace}/${scope}/`);
    return { ...artifact, repositories: artifact.repositories.map(local), targets: artifact.targets.map(target => ({ ...target, ref: local(target.ref) })) };
  });
  const formalWrites = () => calls.filter(call => call.args.includes('create') && !call.args[call.args.indexOf('--tag') + 1].includes(':candidate-'));

  const conflict = localPlan('conflict');
  const last = conflict.at(-1).targets.filter(target => target.immutable).at(-1).ref;
  const latest = `${namespace}/conflict/varin:latest`;
  registry.copy(sources.toolbeltApp, last); // Conflict in the final immutable destination.
  registry.copy(sources.toolbeltApp, latest); // Simulate the pre-cutover toolbelt alias.
  const before = formalWrites().length;
  assert.throws(() => promoteImages(conflict, 'candidate-1-1', registry), /replace immutable/);
  assert.equal(formalWrites().length, before);
  assert.equal(registry.manifest(latest).digest, sources.toolbeltApp.split('@')[1]);
  assert.equal(registry.manifest(`${namespace}/conflict/varin:0.9.39`, { allowMissing: true }), null);

  const success = localPlan('success');
  promoteImages(success, 'candidate-2-1', registry);
  for (const artifact of success) for (const target of artifact.targets) {
    assert.equal(registry.manifest(target.ref).digest, artifact.digest, `Digest changed at ${target.ref}`);
  }
  assert.equal(registry.manifest(`${namespace}/success/varin:latest`).digest, sources.standardApp.split('@')[1]);
  assert.equal(registry.manifest(`${namespace}/success/varin-slim:latest`).digest, sources.standardApp.split('@')[1]);
  assert.equal(registry.manifest(`${namespace}/success/varin-toolbelt:latest`).digest, sources.toolbeltApp.split('@')[1]);
  assert.equal(registry.manifest(`${namespace}/success/varin-runtime-base:latest`).digest, sources.toolbeltBase.split('@')[1]);
  const published = formalWrites().length;
  promoteImages(success, 'candidate-2-2', registry);
  assert.equal(formalWrites().length, published, 'An identical retry rewrote frozen/formal tags');
  assert.ok(calls.some(call => call.options?.anonymous), 'Production anonymous command path was not exercised');

  // The production commit owner is exercised unchanged. Only its registry
  // boundary maps fixed production names to this isolated, disposable registry.
  // These scratch fixtures test index/config/copy/pull behavior, not app startup.
  const names = { standardApp: 'varin', toolbeltApp: 'varin-toolbelt', slimBase: 'varin-runtime-slim', toolbeltBase: 'varin-runtime-toolbelt' };
  const commitReceipt = { schema: 1, repository: 'Youzini-afk/Varin', workflow: '.github/workflows/docker-commit.yml',
    tag: `commit-${commitSource}`, source: { sha: commitSource, version: '0.9.38' },
    producer: { runId: '8', runAttempt: '1', toolingSha: commitTooling }, build: { runId: '8', runAttempt: '1', toolingSha: commitTooling },
    images: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, `${productionPrefix}${name}@${sources[key].split('@')[1]}`])) };
  const scopedRegistry = scope => {
    const local = ref => {
      assert.ok(ref.startsWith(productionPrefix), 'Unexpected production owner');
      return ref.replace(productionPrefix, `${namespace}/${scope}/`);
    };
    for (const [key, name] of Object.entries(names)) registry.copy(sources[key], `${namespace}/${scope}/${name}:candidate-8-1`);
    return { local, manifest: (ref, options) => registry.manifest(local(ref), options),
      config: (ref, options) => registry.config(local(ref), options),
      pull: (ref, options) => registry.pull(local(ref), options), copy: (from, to) => registry.copy(local(from), local(to)) };
  };
  const conflictRegistry = scopedRegistry('commit-conflict'), lastCommit = `${productionPrefix}varin-runtime-base:${commitReceipt.tag}`;
  conflictRegistry.copy(commitReceipt.images.toolbeltApp, lastCommit);
  const beforeCommit = formalWrites().length;
  assert.throws(() => promoteCommitImages(commitReceipt, 'candidate-8-1', conflictRegistry), /replace immutable/);
  assert.equal(formalWrites().length, beforeCommit, 'A final commit-target conflict caused partial writes');
  const retryRegistry = scopedRegistry('commit-retry'), copy = retryRegistry.copy;
  let disconnected = false;
  retryRegistry.copy = (from, to) => {
    copy(from, to);
    if (!disconnected && to === `${productionPrefix}varin:${commitReceipt.tag}`) {
      disconnected = true; throw new Error('Fixture lost the first commit-copy response');
    }
  };
  assert.throws(() => promoteCommitImages(commitReceipt, 'candidate-8-1', retryRegistry), /lost the first commit-copy response/);
  const result = promoteCommitImages(commitReceipt, 'candidate-8-2', retryRegistry);
  assert.equal(result.images.length, 6);
  for (const image of result.images) assert.equal(retryRegistry.manifest(image.ref, { anonymous: true }).digest, image.digest);
  assert.equal(formalWrites().filter(call => call.args[call.args.indexOf('--tag') + 1] === retryRegistry.local(`${productionPrefix}varin:${commitReceipt.tag}`)).length, 1);
  assert.ok(calls.some(call => call.args[0] === 'pull' && call.options?.anonymous), 'Anonymous Docker consumption was not exercised');
});
