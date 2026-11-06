import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acceptImageRelease, createImageRegistry, dockerCommand, imagePromotionPlan,
  promoteImages, resolveRuntimeBase, verifyImage, writeAnonymousDockerConfig } from './docker-release.mjs';

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
    assert.ok(['inspect', 'create'].includes(args[2]), 'Unexpected registry operation');
    const references = args[2] === 'inspect' ? [args[3]] : [args[args.indexOf('--tag') + 1], args.at(-1)];
    assert.ok(references.every(ref => ref.startsWith(`${registryAddress}/`)), 'Fixture attempted a non-loopback registry reference');
    calls.push({ args, options });
    return docker(args, options);
  });
  const namespace = `${registryAddress}/varin-release-fixture-${process.pid}-${Date.now()}`;
  const dockerfile = path.join(root, 'Dockerfile');
  fs.writeFileSync(dockerfile, 'FROM scratch\nARG ROLE\nARG VARIANT\nLABEL io.varin.image.role=$ROLE io.varin.image.variant=$VARIANT\nENV VARIN_IMAGE_VARIANT=$VARIANT\n');
  const sources = {};
  for (const [name, role, variant] of [
    ['standardApp', 'application', 'slim'], ['toolbeltApp', 'application', 'toolbelt'],
    ['slimBase', 'runtime-base', 'slim'], ['toolbeltBase', 'runtime-base', 'toolbelt'],
  ]) {
    const tag = `${namespace}/source-${name.toLowerCase()}:candidate`;
    // Metadata-only indexes: no target-platform commands, QEMU, or application
    // startup claims. The existing real app smokes retain that separate proof.
    execFileSync('docker', ['buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--provenance=false', '--sbom=false',
      '--build-arg', `ROLE=${role}`, '--build-arg', `VARIANT=${variant}`, '--push', '--tag', tag, root],
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
});
