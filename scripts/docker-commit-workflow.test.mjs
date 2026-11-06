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
const entries = block => Object.fromEntries(block.trim().split('\n').map(line => {
  const split = line.indexOf('=');
  assert.ok(split > 0, `Invalid build metadata: ${line}`);
  return [line.slice(0, split), line.slice(split + 1)];
}));
const source = '${{ needs.accept.outputs.source_sha }}';
const tooling = '${{ github.sha }}';
const buildStep = job => job.steps?.find(step => step.uses?.startsWith('docker/build-push-action@'));

test('commit publication is deliberate and all registry writers depend on accepted exact-source qualification', () => {
  assert.deepEqual(Object.keys(commit.on), ['workflow_dispatch']);
  assert.deepEqual(commit.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(commit.on.workflow_dispatch.inputs).sort(), ['resume_run_attempt', 'resume_run_id', 'source_sha']);
  assert.equal(commit.jobs['source-quality'].uses, './.github/workflows/ci.yml');
  assert.deepEqual(commit.jobs['source-quality'].with, { source_sha: source, full: true });
  for (const [id, job] of Object.entries(commit.jobs)) {
    assert.ok(!job.uses || job.uses === './.github/workflows/ci.yml', `Unexpected downstream publication workflow: ${id}`);
    if (job.permissions?.packages !== 'write') continue;
    const parents = ancestors(id);
    assert.ok(parents.includes('accept'), `${id} can publish an unaccepted reference`);
    assert.ok(parents.includes('source-quality'), `${id} can publish without qualification`);
    if (id !== 'promote') assert.equal(job.if, "needs.accept.outputs.mode == 'build'", `${id} rebuilds a recovery candidate`);
  }
  assert.equal(commit.concurrency['cancel-in-progress'], false);
  assert.equal(commit.concurrency.queue, 'max');
  assert.equal(commit.jobs.promote.concurrency.group, release.jobs.promote.concurrency.group);
  assert.equal(commit.jobs.promote.concurrency['cancel-in-progress'], false);
  assert.equal(commit.jobs.promote.concurrency.queue, 'max');
});

test('product checkouts and both architecture builds retain the selected source while execution tooling stays at dispatch SHA', () => {
  for (const [id, job] of Object.entries(commit.jobs)) for (const step of job.steps ?? []) {
    if (!step.uses?.startsWith('actions/checkout@')) continue;
    assert.equal(step.with['persist-credentials'], false, `${id} stores checkout credentials`);
    if (step.with.path === 'tooling') {
      assert.equal(step.with.ref, tooling);
      assert.equal(step.with['fetch-depth'], 0, `${id} cannot prove historical ancestry`);
    } else {
      assert.equal(step.with.path, 'source');
      assert.equal(step.with.ref, source);
    }
  }
  const builders = Object.values(commit.jobs).map(buildStep).filter(Boolean);
  assert.equal(builders.length, 4);
  for (const build of builders) {
    assert.equal(build.with.context, 'source');
    assert.ok(['source/Dockerfile', 'source/Dockerfile.base'].includes(build.with.file));
    assert.equal(build.with.platforms, 'linux/amd64,linux/arm64');
    assert.equal(build.with.provenance, 'mode=max');
    assert.equal(build.with.sbom, true);
    assert.match(build.with.tags, /^ghcr\.io\/youzini-afk\/varin(?:-runtime)?(?:-slim|-toolbelt)?:candidate-/);
    const labels = entries(build.with.labels);
    assert.equal(labels['org.opencontainers.image.source'], 'https://github.com/Youzini-afk/Varin');
    assert.equal(labels['org.opencontainers.image.revision'], source);
    assert.equal(labels['org.opencontainers.image.version'], '${{ needs.accept.outputs.version }}');
    assert.equal(labels['io.varin.publication.kind'], 'commit');
    assert.equal(labels['io.varin.build.run_id'], '${{ github.run_id }}');
    assert.equal(labels['io.varin.build.run_attempt'], '${{ github.run_attempt }}');
    assert.equal(labels['io.varin.build.tooling_sha'], tooling);
  }
});

test('each app binds and records the runtime digest it actually consumed, including recovered candidates', () => {
  const record = commit.jobs.record.steps.find(step => step.id === 'record');
  for (const [variant, runtime, appImage] of [['standard', 'slim', 'varin'], ['toolbelt', 'toolbelt', 'varin-toolbelt']]) {
    const app = commit.jobs[`build-app-${variant}`];
    assert.ok(app.needs.includes(`build-runtime-${runtime}`));
    assert.equal(buildStep(commit.jobs[`build-runtime-${runtime}`]).with.target, runtime);
    const resolver = app.steps.find(step => step.id === 'base');
    assert.equal(resolver['working-directory'], 'tooling');
    assert.equal(resolver.run, `node scripts/docker-commit.mjs resolve-base ${runtime}`);
    assert.equal(resolver.env.BASE_IMAGE, `ghcr.io/youzini-afk/varin-runtime-${runtime}@` + '${{ needs.build-runtime-' + runtime + '.outputs.digest }}');
    const build = buildStep(app);
    assert.equal(build.with.tags, `ghcr.io/youzini-afk/${appImage}:candidate-` + '${{ github.run_id }}-${{ github.run_attempt }}');
    const args = entries(build.with['build-args']);
    assert.equal(args.VARIN_SOURCE_REVISION, source);
    assert.equal(args.RUNTIME_BASE_IMAGE, '${{ steps.base.outputs.image }}');
    assert.equal(entries(build.with.labels)['io.varin.image.base'], args.RUNTIME_BASE_IMAGE);
    assert.equal(app.outputs['base-image'], args.RUNTIME_BASE_IMAGE);
    const imageField = variant === 'standard' ? 'STANDARD_APP_IMAGE' : 'TOOLBELT_APP_IMAGE';
    assert.equal(record.env[imageField], '${{ needs.accept.outputs.mode == \'resume\' && needs.accept.outputs.' + variant + '_app || format(\'ghcr.io/youzini-afk/' + appImage + '@{0}\', needs.build-app-' + variant + '.outputs.digest) }}');
    const baseField = runtime === 'slim' ? 'SLIM_BASE_IMAGE' : 'TOOLBELT_BASE_IMAGE';
    assert.equal(record.env[baseField], '${{ needs.accept.outputs.mode == \'resume\' && needs.accept.outputs.' + runtime + '_base || needs.build-app-' + variant + '.outputs.base-image }}');
  }
});

test('normal and recovered candidates retain both real smokes before the saved producer receipt', () => {
  assert.equal(commit.jobs.record.name, 'Record verified candidate');
  assert.equal(commit.jobs.record.permissions.packages, 'read');
  for (const variant of ['standard', 'toolbelt']) {
    const id = `smoke-${variant}`, smoke = commit.jobs[id];
    assert.ok(ancestors(id).includes('source-quality'));
    assert.ok(commit.jobs.record.needs.includes(id));
    assert.ok(commit.jobs.record.if.includes(`needs.${id}.result == 'success'`));
    assert.ok(smoke.if.includes("needs.accept.outputs.mode == 'resume'"), 'Recovery must run the real smoke instead of inheriting a skipped build');
    assert.equal(smoke.permissions.packages, 'read');
    assert.equal(smoke.env.EXPECTED_RELEASE_ID, 'image-' + source);
    assert.equal(smoke.env.EXPECTED_VERSION, '${{ needs.accept.outputs.version }}');
    assert.ok(smoke.env.IMAGE_REF.includes(`needs.accept.outputs.${variant}_app`));
    assert.ok(smoke.env.IMAGE_REF.includes(`needs.build-app-${variant}.outputs.digest`));
    const node = smoke.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(node.with['node-version'], 24);
    assert.ok(smoke.steps.some(step => step['working-directory'] === 'tooling'));
  }
  const artifact = commit.jobs.record.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.with.name, '${{ steps.record.outputs.artifact_name }}');
  assert.equal(artifact.with.path, 'tooling/artifacts/commit-images/candidate.json');
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
