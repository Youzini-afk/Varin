import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// Publication authority lives in the workflow graph. Exercise its dependencies,
// source/receipt wiring and token capabilities, not shell spelling or step order.
const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = name => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const commit = workflow('docker-commit'), release = workflow('docker');
const ancestors = (id, visited = new Set()) => {
  assert.ok(!visited.has(id), `Publication dependency cycle: ${id}`);
  const branch = new Set([...visited, id]);
  return [commit.jobs[id].needs ?? []].flat().flatMap(parent => [parent, ...ancestors(parent, branch)]);
};
const source = '${{ needs.accept.outputs.source_sha }}';
const tooling = '${{ github.sha }}';
const shared = workflow('container-images');

test('commit candidate writes follow admission while final publication requires exact-source qualification', () => {
  assert.deepEqual(Object.keys(commit.on), ['workflow_dispatch']);
  assert.deepEqual(commit.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(commit.on.workflow_dispatch.inputs).sort(), ['resume_run_attempt', 'resume_run_id', 'source_sha']);
  assert.equal(commit.jobs['source-quality'].uses, './.github/workflows/ci.yml');
  assert.deepEqual(commit.jobs['source-quality'].with, { source_sha: source, full: true, qualification: 'container' });
  for (const [id, job] of Object.entries(commit.jobs)) {
    assert.ok(!job.uses || ['./.github/workflows/ci.yml', './.github/workflows/container-images.yml'].includes(job.uses), `Unexpected downstream publication workflow: ${id}`);
    if (job.permissions?.packages !== 'write') continue;
    const parents = ancestors(id);
    assert.ok(parents.includes('accept'), `${id} can publish an unaccepted reference`);
    if (id === 'promote') assert.ok(parents.includes('source-quality'), 'Commit tags require qualification');
    else assert.ok(!parents.includes('source-quality'), 'Candidate computation must overlap quality');
    if (id !== 'promote') assert.equal(job.if, "needs.accept.outputs.mode == 'build'", `${id} rebuilds a recovery candidate`);
  }
  assert.equal(commit.concurrency['cancel-in-progress'], false);
  assert.equal(commit.concurrency.queue, 'max');
  assert.equal(commit.jobs.promote.concurrency.group, release.jobs.promote.concurrency.group);
  assert.equal(commit.jobs.promote.concurrency['cancel-in-progress'], false);
  assert.equal(commit.jobs.promote.concurrency.queue, 'max');
});

test('reviewed tooling and historical source remain separate in the reusable builder', () => {
  const build = commit.jobs['build-images'];
  assert.equal(build.uses, './.github/workflows/container-images.yml');
  assert.deepEqual(build.with, { source_sha: source, tooling_sha: tooling,
    version: '${{ needs.accept.outputs.version }}', publication: 'commit' });
  assert.deepEqual(shared.permissions, { contents: 'read', packages: 'write' });
  const steps = shared.jobs.build.steps;
  for (const step of steps.filter(step => step.uses?.startsWith('actions/checkout@'))) {
    assert.equal(step.with['persist-credentials'], false);
    assert.equal(step.with.ref, '${{ inputs.' + (step.with.path === 'source' ? 'source_sha' : 'tooling_sha') + ' }}');
    assert.notEqual(step.with['fetch-depth'], 0, 'Builder does not need every branch and tag');
  }
  const validate = steps.findIndex(step => step.run === 'node scripts/build-container-images.mjs validate');
  const login = steps.findIndex(step => step.uses?.startsWith('docker/login-action@'));
  const execute = steps.findIndex(step => step.run === 'node scripts/build-container-images.mjs build');
  assert.ok(validate >= 0 && validate < login && login < execute);
  assert.equal(shared.jobs.build.defaults.run['working-directory'], 'tooling');
  assert.equal(shared.jobs.build.env.CONTAINER_SOURCE_DIR, '../source');
  for (const key of ['standard_app', 'toolbelt_app', 'slim_base', 'toolbelt_base']) {
    assert.equal(shared.on.workflow_call.outputs[key].value, '${{ jobs.build.outputs.' + key + ' }}');
    assert.equal(shared.jobs.build.outputs[key], '${{ steps.build.outputs.' + key + ' }}');
  }
  for (const id of ['accept', 'record', 'promote']) {
    const checkout = commit.jobs[id].steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, tooling);
    assert.equal(checkout.with['fetch-depth'], 0, `${id} retains real history for ancestry proofs`);
    assert.equal(checkout.with['persist-credentials'], false);
  }
});

test('new and recovered candidates record the actual immutable app and companion-base outputs', () => {
  const record = commit.jobs.record.steps.find(step => step.id === 'record');
  for (const [envKey, output] of [['STANDARD_APP_IMAGE', 'standard_app'], ['TOOLBELT_APP_IMAGE', 'toolbelt_app'],
    ['SLIM_BASE_IMAGE', 'slim_base'], ['TOOLBELT_BASE_IMAGE', 'toolbelt_base']]) {
    assert.equal(record.env[envKey], "${{ needs.accept.outputs.mode == 'resume' && needs.accept.outputs." + output
      + ' || needs.build-images.outputs.' + output + ' }}');
  }
});

test('normal and recovered candidates retain both real smokes before the saved producer receipt', () => {
  assert.equal(commit.jobs.record.name, 'Record verified candidate');
  assert.equal(commit.jobs.record.permissions.packages, 'read');
  for (const variant of ['standard', 'toolbelt']) {
    const id = `smoke-${variant}`, smoke = commit.jobs[id];
    assert.ok(!ancestors(id).includes('source-quality'), 'Real smoke may overlap qualification');
    assert.ok(commit.jobs.record.needs.includes(id));
    assert.ok(commit.jobs.record.if.includes(`needs.${id}.result == 'success'`));
    assert.ok(smoke.if.includes("needs.accept.outputs.mode == 'resume'"), 'Recovery must run the real smoke instead of inheriting a skipped build');
    assert.equal(smoke.permissions.packages, 'read');
    assert.equal(smoke.env.EXPECTED_RELEASE_ID, 'image-' + source);
    assert.equal(smoke.env.EXPECTED_VERSION, '${{ needs.accept.outputs.version }}');
    assert.ok(smoke.env.IMAGE_REF.includes(`needs.accept.outputs.${variant}_app`));
    assert.ok(smoke.env.IMAGE_REF.includes(`needs.build-images.outputs.${variant}_app`));
    const node = smoke.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(node.with['node-version'], 24);
    assert.ok(smoke.steps.some(step => step['working-directory'] === 'tooling'));
  }
  const artifact = commit.jobs.record.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.with.name, '${{ steps.record.outputs.artifact_name }}');
  assert.equal(artifact.with.path, 'tooling/artifacts/commit-images/candidate.json');
  assert.equal(artifact.with.archive, true);
  assert.equal(artifact.with['if-no-files-found'], 'error');
  assert.equal(artifact.with.overwrite, false);
  assert.ok(ancestors('promote').includes('record'));
  assert.equal(commit.jobs.promote.if, "${{ !cancelled() && needs.accept.result == 'success' && needs.record.result == 'success' }}");
});

test('promotion reloads the successful producer attempt rather than substituting the retry attempt or arbitrary images', () => {
  const accept = commit.jobs.accept.steps.find(step => step.id === 'accept');
  assert.equal(accept.env.INPUT_RESUME_RUN_ID, '${{ inputs.resume_run_id }}');
  assert.equal(accept.env.INPUT_RESUME_RUN_ATTEMPT, '${{ inputs.resume_run_attempt }}');
  assert.equal(commit.jobs.accept.permissions.actions, 'read');
  assert.equal(commit.jobs.promote.permissions.actions, 'read');
  const promote = commit.jobs.promote.steps.find(step => step.run === 'node scripts/docker-commit.mjs promote');
  assert.ok(promote);
  assert.equal(promote['working-directory'], 'tooling');
  assert.equal(promote.env.CANDIDATE_RUN_ATTEMPT, '${{ needs.record.outputs.artifact_attempt }}');
  assert.equal(promote.env.SOURCE_SHA, source);
  assert.deepEqual(Object.keys(promote.env).sort(), ['CANDIDATE_RUN_ATTEMPT', 'GH_TOKEN', 'SOURCE_SHA', 'SOURCE_VERSION']);
  assert.equal(commit.jobs.record.outputs.artifact_attempt, '${{ steps.record.outputs.artifact_attempt }}');
  assert.ok(!commit.jobs.promote.steps.some(step => step.uses?.startsWith('docker/build-push-action@')), 'Recovery promotion must not rebuild');
  assert.ok(!commit.jobs.promote.steps.some(step => step.run?.includes('docker pull')), 'The fresh promotion daemon must not prefetch authenticated layers');
});

test('record joins full quality and both smokes even when resume skips the builder', () => {
  const expression = commit.jobs.record.if.slice(3, -2).replace(/needs\.([\w-]+)/g, 'results["$1"]').replace('!cancelled()', 'true');
  const evaluate = results => Function('results', `return (${expression});`)(results);
  for (const mode of ['build', 'resume']) {
    const success = Object.fromEntries(commit.jobs.record.needs.map(name => [name, { result: 'success' }]));
    success.accept.outputs = { mode };
    if (mode === 'resume') success['build-images'].result = 'skipped';
    assert.equal(evaluate(success), true);
    for (const name of ['accept', 'source-quality', 'smoke-standard', 'smoke-toolbelt']) {
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        assert.equal(evaluate({ ...success, [name]: { ...success[name], result } }), false, `${mode}: ${name}: ${result}`);
      }
    }
    if (mode === 'build') for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.equal(evaluate({ ...success, 'build-images': { result } }), false);
    }
  }
});
