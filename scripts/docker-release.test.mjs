import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { imageRegistryFixture } from './test-fixtures/image-registry.mjs';
import { acceptImageRelease, assertImageReleaseTag, createImageRegistry, imagePromotionPlan,
  promoteImages, releaseImageAliases, resolveRuntimeBase, verifyImage, writeAnonymousDockerConfig } from './docker-release.mjs';

const source = 'a'.repeat(40);
const input = { eventName: 'push', ref: 'refs/tags/v0.9.39', sha: source, version: '0.9.39' };
const candidate = acceptImageRelease(input);
const digest = value => `sha256:${value.repeat(64)}`;
const prefix = 'ghcr.io/youzini-afk/';
const images = { standardApp: `${prefix}varin@${digest('1')}`, toolbeltApp: `${prefix}varin-toolbelt@${digest('2')}`,
  slimBase: `${prefix}varin-runtime-slim@${digest('3')}`, toolbeltBase: `${prefix}varin-runtime-toolbelt@${digest('4')}` };
const plan = () => imagePromotionPlan(candidate, images, [input.ref]);

const registryFixture = () => imageRegistryFixture(images);

test('tag pushes and manual tag releases share future-only exact-source acceptance', () => {
  const expected = { ref: input.ref, sha: source, version: input.version, aliases: ['0.9.39', '0.9', '0', 'latest', `sha-${source}`] };
  assert.deepEqual(candidate, expected);
  assert.deepEqual(acceptImageRelease({ ...input, eventName: 'workflow_dispatch' }), expected);
  for (const version of ['0.9.38', '0.9.38-rc.1', '0.9.37', '0.8.99']) {
    assert.throws(() => acceptImageRelease({ ...input, ref: `refs/tags/v${version}`, version }), /newer than 0.9.38/);
  }
  assert.ok(acceptImageRelease({ ...input, ref: 'refs/tags/v0.9.39-rc.1', version: '0.9.39-rc.1' }));
});

test('branches, PRs, mismatched versions and nonexact sources cannot publish', () => {
  for (const patch of [{ ref: 'refs/heads/main' }, { eventName: 'workflow_dispatch', ref: 'refs/heads/main' },
    { eventName: 'pull_request' }, { version: '0.9.40' }, { sha: 'main' }, { sha: source.slice(0, 7) },
    { ref: 'refs/tags/v01.2.3', version: '01.2.3' }, { ref: 'refs/tags/v1.2.3-01', version: '1.2.3-01' }]) {
    assert.throws(() => acceptImageRelease({ ...input, ...patch }));
  }
});

test('only the highest retained stable Git release may move the complete floating set', () => {
  assert.deepEqual(releaseImageAliases(candidate, [input.ref, 'refs/tags/v0.10.0-rc.1']), candidate.aliases);
  assert.deepEqual(releaseImageAliases(candidate, [input.ref, 'refs/tags/v0.9.40']), ['0.9.39', `sha-${source}`]);
  assert.deepEqual(releaseImageAliases(candidate, [input.ref, 'refs/tags/v0.10.0']), ['0.9.39', `sha-${source}`]);
  assert.throws(() => releaseImageAliases(candidate, []), /remote release-tag evidence/);
  const prerelease = acceptImageRelease({ ...input, ref: 'refs/tags/v0.10.0-rc.1', version: '0.10.0-rc.1' });
  assert.deepEqual(releaseImageAliases(prerelease, [prerelease.ref]), ['0.10.0-rc.1', `sha-${source}`]);
});

test('new varin and varin-slim share slim bytes while both historical runtime-base and explicit toolbelt bases stay full', () => {
  const targets = new Map(plan().flatMap(image => image.targets.map(target => [target.ref, image.source])));
  for (const alias of candidate.aliases) {
    assert.equal(targets.get(`${prefix}varin:${alias}`), images.standardApp);
    assert.equal(targets.get(`${prefix}varin-slim:${alias}`), images.standardApp);
    assert.equal(targets.get(`${prefix}varin-toolbelt:${alias}`), images.toolbeltApp);
    assert.equal(targets.get(`${prefix}varin-runtime-slim:${alias}`), images.slimBase);
    assert.equal(targets.get(`${prefix}varin-runtime-toolbelt:${alias}`), images.toolbeltBase);
    assert.equal(targets.get(`${prefix}varin-runtime-base:${alias}`), images.toolbeltBase);
  }
  assert.ok(!targets.has(`${prefix}varin:main`));
  assert.throws(() => imagePromotionPlan(candidate, { ...images, toolbeltBase: undefined }, [input.ref]), /immutable image/);
  assert.throws(() => imagePromotionPlan(candidate, { ...images, standardApp: `${prefix}varin:latest` }, [input.ref]), /immutable image/);
});

test('base overrides resolve once, require real runtime role/variant/platforms, and are the published companion', () => {
  const fixture = registryFixture(), override = `registry.example:5000/team/reused-base@${digest('5')}`;
  fixture.add(override, 'runtime-base', 'toolbelt');
  fixture.manifests.set('registry.example:5000/team/reused-base:stable', fixture.manifests.get(override));
  const resolved = resolveRuntimeBase('registry.example:5000/team/reused-base:stable', 'toolbelt', fixture.registry);
  assert.equal(resolved, override);
  const overridePlan = imagePromotionPlan(candidate, { ...images, toolbeltBase: resolved }, [input.ref]);
  promoteImages(overridePlan, 'candidate-12-1', fixture.registry);
  assert.equal(fixture.manifests.get(`${prefix}varin-runtime-toolbelt:0.9.39`).digest, digest('5'));
  assert.equal(fixture.manifests.get(`${prefix}varin-runtime-base:latest`).digest, digest('5'));
  assert.throws(() => resolveRuntimeBase(images.toolbeltApp, 'toolbelt', fixture.registry), /runtime-base\/toolbelt metadata/);
  assert.throws(() => resolveRuntimeBase(images.slimBase, 'toolbelt', fixture.registry), /runtime-base\/toolbelt metadata/);
  fixture.manifests.get(override).manifests.pop();
  assert.throws(() => resolveRuntimeBase(override, 'toolbelt', fixture.registry), /Both linux/);
});

test('resumed release promotion verifies the original source and build labels on both application architectures', () => {
  const fixture = registryFixture();
  const expected = imagePromotionPlan(candidate, images, [input.ref], { runId: '42', runAttempt: '1', toolingSha: source });
  for (const item of expected.filter(item => item.role === 'application')) {
    const repository = item.source.split('@')[0];
    for (const child of fixture.manifests.get(item.source).manifests) {
      Object.assign(fixture.configs.get(`${repository}@${child.digest}`).config.Labels, item.labels);
    }
  }
  for (const item of expected.filter(item => item.role === 'application')) {
    assert.doesNotThrow(() => verifyImage(item.source, item, fixture.registry));
    const arm = fixture.manifests.get(item.source).manifests.find(child => child.platform.architecture === 'arm64');
    const labels = fixture.configs.get(`${item.source.split('@')[0]}@${arm.digest}`).config.Labels;
    labels['io.varin.build.run_id'] = '43';
    assert.throws(() => promoteImages(expected, 'candidate-99-1', fixture.registry), /build identity/);
    assert.equal(fixture.formalWrites().length, 0);
    labels['io.varin.build.run_id'] = '42';
  }
  assert.doesNotThrow(() => promoteImages(expected, 'candidate-99-1', fixture.registry));
});

test('whole-plan preflight finds a last-destination immutable conflict before any release alias changes', () => {
  const fixture = registryFixture();
  fixture.manifests.set(`${prefix}varin-runtime-base:sha-${source}`, { digest: digest('f') });
  assert.throws(() => promoteImages(plan(), 'candidate-12-1', fixture.registry), /replace immutable/);
  assert.equal(fixture.formalWrites().length, 0);
  assert.equal(fixture.manifests.get(`${prefix}varin-runtime-base:sha-${source}`).digest, digest('f'));
});

test('public access must include immutable platform configs in every destination before formal tags', () => {
  const fixture = registryFixture();
  fixture.denied.add(`${prefix}varin-runtime-toolbelt@${digest('4').slice(0, -1)}9`);
  assert.throws(() => promoteImages(plan(), 'candidate-12-1', fixture.registry), /Anonymous pull access failed/);
  assert.equal(fixture.formalWrites().length, 0);
  assert.ok(fixture.events.some(event => event.anonymous && event.ref.startsWith(`${prefix}varin-toolbelt@`)));
});

test('unknown authenticated preflight outcomes never count as missing tags', () => {
  const fixture = registryFixture();
  fixture.fail.lookup = `${prefix}varin-runtime-base:latest`;
  assert.throws(() => promoteImages(plan(), 'candidate-12-1', fixture.registry), /403 Forbidden/);
  assert.equal(fixture.formalWrites().length, 0);
});

test('invalid source roles, duplicate destinations and altered candidate-copy digests stop before release writes', () => {
  const fixture = registryFixture(), invalid = plan();
  invalid[0].targets.push({ ...invalid[1].targets[0] });
  assert.throws(() => promoteImages(invalid, 'candidate-12-1', fixture.registry), /Duplicate promotion/);
  assert.equal(fixture.events.filter(event => event.type === 'copy').length, 0);
  const wrongRole = plan(); wrongRole[0].role = 'runtime-base';
  assert.throws(() => promoteImages(wrongRole, 'candidate-12-1', fixture.registry), /runtime-base\/slim metadata/);
  fixture.fail.copiedDigest = digest('f');
  assert.throws(() => promoteImages(plan(), 'candidate-12-1', fixture.registry), /preserve the verified digest/);
  assert.equal(fixture.formalWrites().length, 0);
});

test('same-digest partial publication retries inspect existing tags and complete without rewriting frozen tags', () => {
  const fixture = registryFixture();
  fixture.fail.target = `${prefix}varin-slim:0.9.39`;
  assert.throws(() => promoteImages(plan(), 'candidate-12-1', fixture.registry), /Connection lost/);
  assert.ok(fixture.formalWrites().every(write => !write.to.endsWith(':latest')));
  const firstTag = `${prefix}varin:0.9.39`;
  assert.equal(fixture.formalWrites().filter(write => write.to === firstTag).length, 1);
  promoteImages(plan(), 'candidate-12-2', fixture.registry);
  assert.equal(fixture.formalWrites().filter(write => write.to === firstTag).length, 1);
  assert.equal(fixture.manifests.get(`${prefix}varin:latest`).digest, digest('1'));
  assert.equal(fixture.manifests.get(`${prefix}varin-toolbelt:latest`).digest, digest('2'));
  const writes = fixture.formalWrites(), firstFloat = writes.findIndex(write => write.to.endsWith(':0.9'));
  assert.ok(writes.slice(firstFloat).every(write => !write.to.endsWith(':0.9.39') && !write.to.includes(':sha-')));
  const before = writes.length;
  promoteImages(plan(), 'candidate-12-3', fixture.registry);
  assert.equal(fixture.formalWrites().length, before);
});

test('acknowledged tags may become visible after a short delay without repeating any writes', () => {
  const fixture = registryFixture(), waiting = new Map(), delays = [];
  const { copy, manifest } = fixture.registry;
  fixture.registry.copy = (from, to) => { copy(from, to); waiting.set(to, 2); };
  fixture.registry.manifest = (ref, options) => {
    if (waiting.get(ref) > 0) {
      assert.equal(options?.allowMissing, true);
      waiting.set(ref, waiting.get(ref) - 1);
      return null;
    }
    return manifest(ref, options);
  };
  promoteImages(plan(), 'candidate-12-1', fixture.registry, { wait: delay => delays.push(delay) });
  const writes = fixture.events.filter(event => event.type === 'copy');
  assert.equal(new Set(writes.map(write => write.to)).size, writes.length);
  assert.deepEqual(delays.slice(0, 2), [1000, 2000]);
  assert.equal(fixture.manifests.get(`${prefix}varin:latest`).digest, digest('1'));

  fixture.registry.manifest = (ref, options) => ref.includes(':candidate-13-') ? null : manifest(ref, options);
  assert.throws(() => promoteImages(plan(), 'candidate-13-1', fixture.registry, { wait() {} }), /still not visible/);
});

test('a rebuilt retry with different bytes conflicts rather than replacing an exact version', () => {
  const fixture = registryFixture();
  promoteImages(plan(), 'candidate-12-1', fixture.registry);
  const replacement = `${prefix}varin@${digest('6')}`;
  fixture.add(replacement, 'application', 'slim');
  const before = fixture.formalWrites().length;
  assert.throws(() => promoteImages(imagePromotionPlan(candidate, { ...images, standardApp: replacement }, [input.ref]), 'candidate-12-2', fixture.registry), /replace immutable/);
  assert.equal(fixture.formalWrites().length, before);
  assert.equal(fixture.manifests.get(`${prefix}varin:0.9.39`).digest, digest('1'));
});

test('explicit version republication replaces release aliases and preserves prior source tags', () => {
  const fixture = registryFixture();
  promoteImages(plan(), 'candidate-12-1', fixture.registry);
  const replacement = `${prefix}varin@${digest('6')}`;
  fixture.add(replacement, 'application', 'slim');
  const next = acceptImageRelease({ ...input, eventName: 'workflow_dispatch', sha: 'b'.repeat(40) });
  const nextPlan = imagePromotionPlan(next, { ...images, standardApp: replacement }, [input.ref]);
  promoteImages(nextPlan, 'candidate-13-1', fixture.registry, { replaceVersion: next.version });
  for (const name of ['varin', 'varin-slim']) {
    assert.equal(fixture.manifests.get(`${prefix}${name}:0.9.39`).digest, digest('6'));
    assert.equal(fixture.manifests.get(`${prefix}${name}:latest`).digest, digest('6'));
    assert.equal(fixture.manifests.get(`${prefix}${name}:sha-${source}`).digest, digest('1'));
    assert.equal(fixture.manifests.get(`${prefix}${name}:sha-${next.sha}`).digest, digest('6'));
  }
  const before = fixture.formalWrites().length;
  assert.throws(() => promoteImages(imagePromotionPlan(next, images, [input.ref]), 'candidate-14-1', fixture.registry,
    { replaceVersion: next.version }), /replace immutable/);
  assert.equal(fixture.formalWrites().length, before);
});

test('an older release leaves ALL floats untouched after a partial newer publication, despite reused base labels', () => {
  const fixture = registryFixture();
  for (const image of plan()) for (const target of image.targets.filter(target => !target.immutable)) {
    fixture.manifests.set(target.ref, { digest: digest('e') });
  }
  const historical = imagePromotionPlan(candidate, images, [input.ref, 'refs/tags/v0.9.40']);
  promoteImages(historical, 'candidate-12-1', fixture.registry);
  assert.ok(fixture.formalWrites().every(write => write.to.endsWith(':0.9.39') || write.to.includes(':sha-')));
  for (const image of plan()) for (const target of image.targets.filter(target => !target.immutable)) {
    assert.equal(fixture.manifests.get(target.ref).digest, digest('e'));
  }
});

test('the registry adapter fails closed and requests digest-preserving copy, not a rebuilt index', () => {
  const ref = `${prefix}varin:0.9.39`, calls = [];
  let stderr = `ERROR: ${ref}: not found\n`;
  const registry = createImageRegistry((args, options) => {
    calls.push({ args, options });
    if (args.includes('create')) return '';
    if (stderr) throw Object.assign(new Error('lookup failed'), { stderr });
    return JSON.stringify({ digest: digest('1') });
  });
  assert.equal(registry.manifest(ref, { allowMissing: true }), null);
  assert.throws(() => registry.manifest(ref), /lookup failed/);
  for (const error of ['ERROR: 403 Forbidden', 'ERROR: unauthorized', 'ERROR: network: not found', `ERROR: ${ref}-other: not found`]) {
    stderr = error; assert.throws(() => registry.manifest(ref, { allowMissing: true }), /lookup failed/);
  }
  stderr = '';
  registry.manifest(ref, { anonymous: true });
  assert.equal(calls.at(-1).options.anonymous, true);
  registry.copy(images.standardApp, ref);
  assert.deepEqual(calls.at(-1).args, ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', ref, images.standardApp]);
  assert.throws(() => createImageRegistry(() => 'null').manifest(ref, { allowMissing: true }), /Invalid registry/);
});

test('single-platform manifests or duplicate platforms cannot silently change the tested digest shape', () => {
  const fixture = registryFixture(), manifest = fixture.manifests.get(images.standardApp);
  manifest.mediaType = 'application/vnd.oci.image.manifest.v1+json';
  assert.throws(() => verifyImage(images.standardApp, plan()[0], fixture.registry), /multi-platform image index/);
  manifest.mediaType = 'application/vnd.oci.image.index.v1+json';
  manifest.manifests[1] = manifest.manifests[0];
  assert.throws(() => verifyImage(images.standardApp, plan()[0], fixture.registry), /duplicate platform/);
});

test('anonymous Docker config prevents platform credential-helper autodetection without copying credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-anonymous-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAnonymousDockerConfig(root, '/existing-docker-config');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.deepEqual(config, {
    auths: { 'ghcr.io': {} }, cliPluginsExtraDirs: [path.join('/existing-docker-config', 'cli-plugins')],
  });
  // Nonempty auths makes Docker ContainsAuth true, so it will not discover an
  // OS keychain helper. The GHCR entry itself contains no authentication data.
  assert.equal(Object.keys(config.auths).length, 1);
  assert.equal(Object.keys(config.auths['ghcr.io']).length, 0);
});

test('promotion rechecks lightweight and annotated release tags and rejects a moved tag', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-image-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Image release fixture', '-c', 'user.email=ci@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'candidate');
  const sha = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', root);
  git('tag', 'v0.9.39');
  assert.ok(assertImageReleaseTag(acceptImageRelease({ ...input, sha }), root).includes(input.ref));
  git('tag', '-d', 'v0.9.39');
  git('tag', '-a', 'v0.9.39', '-m', 'annotated release');
  assertImageReleaseTag(acceptImageRelease({ ...input, sha }), root);
  git('commit', '--quiet', '--allow-empty', '-m', 'later');
  git('tag', '-f', 'v0.9.39');
  assert.throws(() => assertImageReleaseTag(acceptImageRelease({ ...input, sha }), root), /tag moved/);
});
