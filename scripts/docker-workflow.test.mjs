import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The workflow graph owns publication authority. Check those capabilities and
// dependencies, not the spelling/order of implementation steps or test lists.
const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = name => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const release = workflow('docker'), validation = workflow('container-check');

test('only release-tag pushes or deliberate manual releases enter the publisher', () => {
  assert.deepEqual(Object.keys(release.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(release.on.push, { tags: ['v*.*.*'] });
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.equal(release.jobs.promote.concurrency['cancel-in-progress'], false);
});

test('every registry writer depends on accepted exact-source qualification', () => {
  const quality = release.jobs['source-quality'];
  assert.equal(quality.uses, './.github/workflows/ci.yml');
  assert.deepEqual(quality.with, { source_sha: '${{ github.sha }}', full: true });
  const ancestors = (id, visited = new Set()) => {
    assert.ok(!visited.has(id), `Workflow dependency cycle at ${id}`);
    const branch = new Set([...visited, id]);
    return [release.jobs[id].needs ?? []].flat().flatMap(parent => [parent, ...ancestors(parent, branch)]);
  };
  for (const [id, job] of Object.entries(release.jobs)) {
    if (job.permissions?.packages !== 'write') continue;
    const dependencies = ancestors(id);
    assert.ok(dependencies.includes('candidate'), `${id} can publish without an accepted release tag`);
    assert.ok(dependencies.includes('source-quality'), `${id} can publish without exact-source qualification`);
  }
  for (const name of ['build-app-toolbelt', 'build-app-standard', 'smoke-toolbelt', 'smoke-standard']) {
    assert.ok(release.jobs.promote.needs.includes(name), `Promotion lacks ${name} evidence`);
  }
});

test('reusable container validation only pushes to its disposable local registry', () => {
  assert.deepEqual(Object.keys(validation.on), ['workflow_call']);
  assert.deepEqual(validation.permissions, { contents: 'read' });
  assert.equal(validation.on.workflow_call.inputs.source_sha.required, true);
  for (const job of Object.values(validation.jobs)) {
    assert.notEqual(job.permissions?.packages, 'write');
    for (const step of job.steps) {
      assert.ok(!step.uses?.startsWith('docker/login-action'), 'Validation must not acquire registry credentials');
      if (step.with?.push === true) {
        assert.ok(step.with.tags.startsWith('localhost:5000/'), 'Validation must not publish remote images');
      }
    }
  }
});

test('release smokes run candidate-owned scripts with their supported Node runtime', () => {
  for (const id of ['smoke-toolbelt', 'smoke-standard']) {
    const job = release.jobs[id];
    assert.equal(job.permissions.contents, 'read', `${id} must be able to check out its smoke scripts`);
    const checkout = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
    const node = job.steps.findIndex(step => step.uses?.startsWith('actions/setup-node@'));
    const execute = job.steps.findIndex(step => step.run);
    assert.ok(checkout >= 0 && checkout < execute, `${id} must check out the candidate before running scripts`);
    assert.equal(job.steps[checkout].with.ref, '${{ github.sha }}');
    assert.ok(node >= 0 && node < execute, `${id} must prepare Node before running scripts`);
    assert.equal(job.steps[node].with['node-version'], 24);
  }
});


test('default local builds follow a published release base, not a retired main alias', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const direct = /^ARG RUNTIME_BASE_IMAGE=(.+)$/mu.exec(dockerfile)?.[1];
  assert.equal(direct, 'ghcr.io/youzini-afk/varin-runtime-slim:latest');
  for (const [file, image] of [['docker-compose.yml', 'varin-runtime-slim'], ['docker-compose.toolbelt.yml', 'varin-runtime-toolbelt']]) {
    const compose = parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    const argument = compose.services.varin.build.args.RUNTIME_BASE_IMAGE;
    assert.equal(argument, '${VARIN_RUNTIME_BASE_IMAGE:-ghcr.io/youzini-afk/' + image + ':latest}');
  }
});


test('release builders, smoke consumers and promotion retain each explicit variant and consumed base', () => {
  const promotion = release.jobs.promote.steps.find(step => step.run === 'node scripts/docker-release.mjs promote');
  for (const [variant, appJob, baseJob, baseStep, imageVariable, baseVariable, appImage, target] of [
    ['slim', 'build-app-standard', 'build-runtime-slim', 'runtime-slim', 'STANDARD_APP_IMAGE_NAME', 'SLIM_BASE_IMAGE_NAME', 'varin', 'slim'],
    ['toolbelt', 'build-app-toolbelt', 'build-runtime-toolbelt', 'runtime-base', 'TOOLBELT_APP_IMAGE_NAME', 'TOOLBELT_BASE_IMAGE_NAME', 'varin-toolbelt', 'toolbelt'],
  ]) {
    const job = release.jobs[appJob];
    assert.ok(job.needs.includes(baseJob));
    assert.equal(release.env[imageVariable], 'youzini-afk/' + appImage);
    const baseBuild = release.jobs[baseJob].steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
    assert.equal(baseBuild.with.target, target);
    const resolver = job.steps.find(step => step.id === baseStep);
    assert.equal(resolver.run, 'node scripts/docker-release.mjs resolve-base ' + variant);
    assert.equal(resolver.env.BASE_REPOSITORY, '${{ env.REGISTRY }}/${{ env.' + baseVariable + ' }}');
    assert.equal(job.outputs['base-image'], '${{ steps.' + baseStep + '.outputs.image }}');
    const build = job.steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
    const args = Object.fromEntries(build.with['build-args'].trim().split('\n').map(line => {
      const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
    }));
    assert.equal(args.RUNTIME_BASE_IMAGE, job.outputs['base-image']);
    const smoke = release.jobs[variant === 'slim' ? 'smoke-standard' : 'smoke-toolbelt'];
    assert.equal(smoke.env.IMAGE_REF, 'ghcr.io/youzini-afk/' + appImage + '@${{ needs.' + appJob + '.outputs.digest }}');
    const key = variant === 'slim' ? 'VARIN_SLIM_BASE_IMAGE' : 'VARIN_TOOLBELT_BASE_IMAGE';
    assert.equal(promotion.env[key], '${{ needs.' + appJob + '.outputs.base-image }}');
  }
});

const composeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore', windowsHide: true }).status === 0;
test('real Compose merge selects standard or toolbelt while retaining deployment mounts and budgets', {
  skip: !composeAvailable && 'Docker Compose is unavailable locally; container CI must exercise this consumer',
}, () => {
  const root = new URL('../', import.meta.url);
  const config = files => JSON.parse(execFileSync('docker', ['compose', ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, VARIN_IMAGE: '', VARIN_RUNTIME_BASE_IMAGE: '',
      VARIN_UI_PASSWORD: 'varin-compose-test-only', VARIN_STOP_GRACE_PERIOD: '15s' },
  }));
  const standard = config(['docker-compose.yml']).services.varin;
  const toolbelt = config(['docker-compose.yml', 'docker-compose.toolbelt.yml']).services.varin;
  assert.equal(standard.image, 'ghcr.io/youzini-afk/varin:latest');
  assert.equal(toolbelt.image, 'ghcr.io/youzini-afk/varin-toolbelt:latest');
  assert.equal(standard.build.args.RUNTIME_BASE_IMAGE, 'ghcr.io/youzini-afk/varin-runtime-slim:latest');
  assert.equal(toolbelt.build.args.RUNTIME_BASE_IMAGE, 'ghcr.io/youzini-afk/varin-runtime-toolbelt:latest');
  assert.deepEqual(toolbelt.volumes, standard.volumes);
  assert.equal(toolbelt.stop_grace_period, standard.stop_grace_period);
  assert.equal(toolbelt.user, standard.user);
});
