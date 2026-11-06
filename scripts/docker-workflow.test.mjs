import assert from 'node:assert/strict';
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
  for (const name of ['build-app', 'build-app-slim', 'smoke-amd64', 'smoke-amd64-slim']) {
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
  for (const id of ['smoke-amd64', 'smoke-amd64-slim']) {
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
