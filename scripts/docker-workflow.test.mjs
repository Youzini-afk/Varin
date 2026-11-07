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

test('candidate computation overlaps quality but final release promotion requires all qualified evidence', () => {
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
    if (id === 'promote') assert.ok(dependencies.includes('source-quality'), 'Final tags require qualification');
    else assert.ok(!dependencies.includes('source-quality'), 'Candidate computation must overlap qualification');
  }
  for (const name of ['build-images', 'source-quality', 'smoke-toolbelt', 'smoke-standard']) {
    assert.ok(release.jobs.promote.needs.includes(name), `Promotion lacks ${name} evidence`);
  }
});

test('reusable container validation only pushes to its disposable local registry', () => {
  assert.deepEqual(Object.keys(validation.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.equal(validation.on.workflow_dispatch.inputs.benchmark.default, true);
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

test('validation exercises sibling checkouts and benchmark restoration has no original builder state', () => {
  const steps = validation.jobs.verify.steps;
  const source = steps.find(step => step.with?.path === 'source');
  const tooling = steps.find(step => step.with?.path === 'tooling');
  assert.equal(source.with.ref, '${{ inputs.source_sha || github.sha }}');
  assert.equal(tooling.with.ref, '${{ inputs.tooling_sha || github.sha }}');
  for (const step of steps.filter(step => step.run?.startsWith('node scripts/build-container-images.mjs'))) {
    assert.equal(step['working-directory'], 'tooling');
    assert.ok(['../source', '../benchmark-source'].includes(step.env.CONTAINER_SOURCE_DIR));
  }
  const fixture = steps.findIndex(step => step.id === 'fixture');
  const restore = steps.findIndex(step => step.id === 'restored');
  assert.ok(fixture > 0 && restore > fixture);
  assert.ok(steps[fixture].run.includes('docker buildx rm "$ORIGINAL_BUILDER"'));
  assert.ok(steps.slice(fixture + 1, restore).some(step => step.uses?.startsWith('docker/setup-buildx-action')));
  assert.equal(steps[restore].env.CONTAINER_SOURCE_SHA, '${{ steps.fixture.outputs.sha }}');
  assert.equal(steps[restore].env.CONTAINER_LOCAL_CACHE, true);
  assert.match(steps[restore].run, /dependencyCookExecutions !== 0/);
  assert.match(steps[restore].run, /dependencyCookUnknown !== 0/);
  const smoke = steps.find(step => step.name === 'Verify the restored image has the new source identity');
  assert.match(smoke.if, /steps.restored.outputs.standard_app != ''/);
  assert.match(steps[restore].run, /dependencyCookCacheHits < restored.platforms.length/);
  assert.match(steps[restore].run, /kernelBuildExecutions < restored.platforms.length/);
});

test('ARM service smoke starts the real Host before invoking authenticated services', () => {
  const step = validation.jobs.verify.steps.find(step => step.name === 'Smoke target-architecture native dependencies');
  assert.match(step.run, /docker run --detach --platform linux\/arm64/);
  assert.ok(!step.run.includes('--entrypoint'));
  assert.match(step.run, /http:\/\/127\.0\.0\.1:3000\/health/);
  assert.match(step.run, /docker exec varin-arm64-smoke node verify-kernel.mjs packages\/web/);
  assert.match(step.run, /docker exec varin-arm64-smoke node verify-services.mjs/);
  assert.ok(step.run.indexOf('docker run --detach') < step.run.indexOf('node verify-services.mjs'));
  const fixture = validation.jobs.verify.steps.find(step => step.id === 'fixture');
  assert.match(fixture.if, /!cancelled\(\).*steps.warm.outcome == 'success'/);
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


test('release callers preserve exact build identities, explicit overrides and immutable output routing', () => {
  const build = release.jobs['build-images'];
  assert.equal(build.uses, './.github/workflows/container-images.yml');
  assert.equal(build.with.source_sha, '${{ github.sha }}');
  assert.equal(build.with.tooling_sha, '${{ github.sha }}');
  assert.equal(build.with.publication, 'release');
  assert.equal(build.with.runtime_slim_image, "${{ inputs.runtime_slim_image || '' }}");
  assert.equal(build.with.runtime_base_image, "${{ inputs.runtime_base_image || '' }}");
  const promotion = release.jobs.promote.steps.find(step => step.run === 'node scripts/docker-release.mjs promote');
  for (const variant of ['standard', 'toolbelt']) {
    const smoke = release.jobs[`smoke-${variant}`];
    assert.deepEqual(smoke.needs, ['build-images']);
    assert.equal(smoke.env.IMAGE_REF, '${{ needs.build-images.outputs.' + variant + '_app }}');
    assert.equal(promotion.env['VARIN_' + variant.toUpperCase() + '_APP_IMAGE'], smoke.env.IMAGE_REF);
  }
  assert.equal(promotion.env.VARIN_SLIM_BASE_IMAGE, '${{ needs.build-images.outputs.slim_base }}');
  assert.equal(promotion.env.VARIN_TOOLBELT_BASE_IMAGE, '${{ needs.build-images.outputs.toolbelt_base }}');
});

test('failed, cancelled or skipped qualification cannot promote already-built release candidates', () => {
  // Evaluate the actual gate with only the supported Actions boolean operators.
  const expression = release.jobs.promote.if.slice(3, -2).replace(/needs\.([\w-]+)/g, 'results["$1"]').replace('!cancelled()', 'true');
  const evaluate = results => Function('results', `return (${expression});`)(results);
  const success = Object.fromEntries(release.jobs.promote.needs.map(name => [name, { result: 'success' }]));
  assert.equal(evaluate(success), true);
  for (const name of release.jobs.promote.needs) for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(evaluate({ ...success, [name]: { result } }), false, `${name}: ${result}`);
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
