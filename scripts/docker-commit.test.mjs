import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acceptImageRelease, createImageRegistry } from './docker-release.mjs';
import { acceptCommitPublication, assertAncestor, assertCurrentMain, commitImagePlan, loadVerifiedCandidate,
  createCommitRegistry, incompletePublication, publicationFailure, promoteCommitImages, readCandidateArchive,
  sourceVersion, validateCandidateReceipt, verifyCommitImages } from './docker-commit.mjs';
import { imageRegistryFixture } from './test-fixtures/image-registry.mjs';

const source = 'a'.repeat(40), tooling = 'b'.repeat(40), prefix = 'ghcr.io/youzini-afk/';
const digest = value => `sha256:${value.repeat(64)}`;
const images = { standardApp: `${prefix}varin@${digest('1')}`, toolbeltApp: `${prefix}varin-toolbelt@${digest('2')}`,
  slimBase: `${prefix}varin-runtime-slim@${digest('3')}`, toolbeltBase: `${prefix}varin-runtime-toolbelt@${digest('4')}` };
const input = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'Youzini-afk/Varin',
  sourceSha: source, toolingSha: tooling, version: '0.9.38' };
const receipt = () => ({ schema: 1, repository: 'Youzini-afk/Varin', workflow: '.github/workflows/docker-commit.yml',
  tag: `commit-${source}`, source: { sha: source, version: '0.9.38' },
  producer: { runId: '42', runAttempt: '2', toolingSha: tooling },
  build: { runId: '42', runAttempt: '2', toolingSha: tooling }, images: { ...images } });

function registryFixture() {
  const fixture = imageRegistryFixture(images);
  for (const [ref, config] of fixture.configs) {
    const labels = config.config.Labels;
    Object.assign(labels, { 'org.opencontainers.image.source': 'https://github.com/Youzini-afk/Varin',
      'org.opencontainers.image.revision': source, 'org.opencontainers.image.version': '0.9.38',
      'io.varin.publication.kind': 'commit', 'io.varin.build.run_id': '42', 'io.varin.build.tooling_sha': tooling,
      'io.varin.build.run_attempt': labels['io.varin.image.role'] === 'runtime-base' ? '1' : '2' });
    if (ref.startsWith(`${prefix}varin@`)) labels['io.varin.image.base'] = images.slimBase;
    if (ref.startsWith(`${prefix}varin-toolbelt@`)) labels['io.varin.image.base'] = images.toolbeltBase;
  }
  fixture.registry.pull = (ref, options) => {
    fixture.events.push({ type: 'pull', ref, ...options });
    if (fixture.fail.pull === ref) throw new Error('Anonymous layer request failed');
  };
  return fixture;
}

test('manual main commit publication accepts 0.9.38 without entering the formal release namespace', () => {
  assert.equal(acceptCommitPublication(input).tag, `commit-${source}`);
  assert.throws(() => acceptImageRelease({ eventName: 'workflow_dispatch', ref: 'refs/tags/v0.9.38', sha: source, version: '0.9.38' }), /newer than/);
  for (const patch of [{ eventName: 'push' }, { eventName: 'pull_request' }, { ref: 'refs/heads/feature' },
    { ref: 'refs/tags/v0.9.39' }, { repository: 'someone/Varin' }, { sourceSha: 'main' }, { sourceSha: source.slice(0, 7) },
    { sourceSha: 'A'.repeat(40) }, { toolingSha: '' }, { version: '01.9.38' }]) {
    assert.throws(() => acceptCommitPublication({ ...input, ...patch }));
  }
});

function gitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-commit-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote'), checkout = path.join(root, 'tooling'); fs.mkdirSync(remote);
  const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Image fixture', '-c', 'user.email=ci@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(remote, 'init', '--quiet', '--initial-branch=main');
  for (const file of ['package.json', 'packages/ui/package.json', 'packages/web/package.json', 'packages/electron/package.json']) {
    fs.mkdirSync(path.dirname(path.join(remote, file)), { recursive: true }); fs.writeFileSync(path.join(remote, file), '{"version":"0.9.38"}\n');
  }
  run(remote, 'add', '.'); run(remote, 'commit', '--quiet', '-m', 'product');
  const sourceSha = run(remote, 'rev-parse', 'HEAD');
  run(remote, 'commit', '--quiet', '--allow-empty', '-m', 'trusted tooling');
  const toolingSha = run(remote, 'rev-parse', 'HEAD');
  run(root, 'clone', '--quiet', '--no-hardlinks', remote, checkout); run(checkout, 'checkout', '--quiet', '--detach', toolingSha);
  return { root, remote, checkout, run, sourceSha, toolingSha };
}

test('real Git ancestry preserves a selected source across normal main movement and rejects removed history', t => {
  const f = gitFixture(t), candidate = acceptCommitPublication({ ...input, sourceSha: f.sourceSha, toolingSha: f.toolingSha });
  assert.equal(sourceVersion(f.sourceSha, f.checkout), '0.9.38');
  assertAncestor(f.sourceSha, f.toolingSha, f.checkout);
  f.run(f.remote, 'commit', '--quiet', '--allow-empty', '-m', 'later main');
  assert.equal(assertCurrentMain(candidate, f.checkout), f.run(f.remote, 'rev-parse', 'HEAD'));
  assert.equal(f.run(f.checkout, 'rev-parse', 'HEAD'), f.toolingSha);
  assert.throws(() => assertAncestor(f.toolingSha, f.sourceSha, f.checkout), /not in trusted main history/);
  f.run(f.remote, 'checkout', '--quiet', '--orphan', 'rewritten'); f.run(f.remote, 'commit', '--quiet', '-m', 'different history');
  f.run(f.remote, 'branch', '-f', 'main', 'HEAD');
  assert.throws(() => assertCurrentMain(candidate, f.checkout), /not in trusted main history/);
  assert.throws(() => assertAncestor('f'.repeat(40), f.toolingSha, f.checkout));
});

test('all six commit targets are immutable and keep compatibility names on exactly the same artifact', () => {
  const plan = commitImagePlan(receipt()), targets = plan.flatMap(item => item.targets);
  assert.equal(targets.length, 6);
  assert.ok(targets.every(item => item.immutable && item.ref.endsWith(`:commit-${source}`)));
  assert.deepEqual(plan[0].repositories, [`${prefix}varin`, `${prefix}varin-slim`]);
  assert.deepEqual(plan[3].repositories, [`${prefix}varin-runtime-toolbelt`, `${prefix}varin-runtime-base`]);
  for (const invalid of [{ ...receipt(), tag: 'latest' }, { ...receipt(), images: { ...images, toolbeltApp: `${prefix}varin:latest` } },
    { ...receipt(), images: { ...images, standardApp: `${prefix}varin-slim@${digest('1')}` } },
    { ...receipt(), images: { standardApp: images.standardApp } }]) assert.throws(() => validateCandidateReceipt(invalid));
});

test('both platform configs bind source, tooling, mixed build attempts and actual companion bases', () => {
  verifyCommitImages(receipt(), registryFixture().registry); // base attempt 1, app attempt 2.
  for (const [name, value] of [['org.opencontainers.image.revision', tooling], ['io.varin.build.tooling_sha', source],
    ['io.varin.build.run_id', '41'], ['io.varin.build.run_attempt', '3'], ['io.varin.publication.kind', 'release'],
    ['org.opencontainers.image.version', '0.9.39'], ['io.varin.image.base', images.toolbeltBase]]) {
    const f = registryFixture(), config = f.configs.get(`${prefix}varin@${digest('1').slice(0, -1)}9`);
    config.config.Labels[name] = value;
    assert.throws(() => verifyCommitImages(receipt(), f.registry), undefined, name);
    assert.equal(f.formalWrites().length, 0);
  }
});

test('anonymous Docker layer consumption gates all commit tags and successful publication reports every exact digest', () => {
  const f = registryFixture();
  for (const tag of ['latest', '0.9', '0', '0.9.38', `sha-${source}`]) f.manifests.set(`${prefix}varin:${tag}`, { digest: digest('e') });
  const result = promoteCommitImages(receipt(), 'candidate-42-2', f.registry);
  assert.equal(result.images.length, 6); assert.equal(result.anonymousPullPlatform, 'linux/amd64');
  const pulls = f.events.filter(event => event.type === 'pull');
  assert.equal(pulls.length, 6); assert.ok(pulls.every(event => event.anonymous));
  assert.ok(f.events.findIndex(event => event.type === 'copy' && event.to.includes(':commit-')) > f.events.findLastIndex(event => event.type === 'pull'));
  assert.equal(f.formalWrites().length, 6);
  for (const item of result.images) assert.equal(f.manifests.get(item.ref).digest, item.digest);
  for (const tag of ['latest', '0.9', '0', '0.9.38', `sha-${source}`]) assert.equal(f.manifests.get(`${prefix}varin:${tag}`).digest, digest('e'));
  promoteCommitImages(receipt(), 'candidate-42-3', f.registry);
  assert.equal(f.formalWrites().length, 6, 'Retry must not rewrite identical frozen tags');
});

test('anonymous layer failure, unknown preflight and a last-target conflict leave every commit tag untouched', () => {
  for (const failure of ['pull', 'unknown', 'conflict']) {
    const f = registryFixture(), last = `${prefix}varin-runtime-base:commit-${source}`;
    if (failure === 'pull') f.fail.pull = images.toolbeltApp;
    if (failure === 'unknown') f.fail.lookup = last;
    if (failure === 'conflict') f.manifests.set(last, { digest: digest('f') });
    assert.throws(() => promoteCommitImages(receipt(), 'candidate-42-2', f.registry));
    assert.equal(f.formalWrites().length, 0, failure);
  }
});

test('an uncertain first write resumes with the original digests without rewriting it or rebuilding', () => {
  const f = registryFixture(), first = `${prefix}varin:commit-${source}`;
  f.fail.target = first;
  assert.throws(() => promoteCommitImages(receipt(), 'candidate-42-2', f.registry), /Connection lost/);
  assert.equal(f.manifests.get(first).digest, digest('1'));
  const result = promoteCommitImages(receipt(), 'candidate-50-1', f.registry);
  assert.equal(result.images.length, 6);
  assert.equal(f.formalWrites().filter(event => event.to === first).length, 1);
  const rebuilt = receipt(); rebuilt.images.standardApp = `${prefix}varin@${digest('5')}`;
  f.add(rebuilt.images.standardApp, 'application', 'slim');
  const originalConfig = f.configs.get(`${prefix}varin@${digest('1').slice(0, -1)}8`);
  for (const suffix of ['8', '9']) {
    const config = f.configs.get(`${prefix}varin@${digest('5').slice(0, -1)}${suffix}`);
    config.config = structuredClone(originalConfig.config);
  }
  assert.throws(() => promoteCommitImages(rebuilt, 'candidate-51-1', f.registry), /replace immutable/);
  assert.equal(f.formalWrites().length, 6);
});

test('a final readback failure never returns a complete publication despite preceding successful writes', () => {
  const f = registryFixture(), copy = f.registry.copy;
  f.registry.copy = (from, to) => { copy(from, to); if (to === `${prefix}varin-runtime-base:commit-${source}`) f.fail.lookup = `${prefix}varin:commit-${source}`; };
  assert.throws(() => promoteCommitImages(receipt(), 'candidate-42-2', f.registry), /403 Forbidden/);
  assert.equal(f.formalWrites().length, 6);
});

test('incomplete receipts distinguish no attempt in this job from unknown existing registry effects', () => {
  const candidate = acceptCommitPublication(input), publication = { runId: '50', runAttempt: '1', toolingSha: tooling };
  const before = incompletePublication(candidate, null, publication, 'verify-candidate');
  assert.equal(before.status, 'incomplete'); assert.equal(before.expectedImages, null);
  assert.equal(before.promotionAttemptedInThisJob, false); assert.equal(before.registryState, 'unknown-until-reconciled');
  const after = incompletePublication(candidate, { receipt: receipt(), artifact: { id: 80 } }, publication, 'promote-and-readback');
  assert.equal(after.promotionAttemptedInThisJob, true); assert.equal(after.expectedImages.length, 6);
  assert.ok(after.expectedImages.every(image => !('written' in image)));
  assert.equal(after.registryState, 'unknown-until-reconciled');
});

test('the real Docker adapter passes anonymous credentials isolation to layer pulls', () => {
  const calls = [], registry = createImageRegistry((args, options) => calls.push({ args, options }));
  registry.pull(images.standardApp, { anonymous: true });
  assert.deepEqual(calls, [{ args: ['pull', '--platform', 'linux/amd64', images.standardApp], options: { anonymous: true } }]);
});

test('public failure details retain safe registry targets and HTTP/transport distinction without signed URLs', () => {
  for (const [detail, httpStatus, transportFailure] of [
    ['request https://download.invalid/?sig=do-not-print returned 403 Forbidden', 403, false],
    ['request https://download.invalid/?sig=do-not-print: context deadline exceeded', null, true],
  ]) {
    const registry = createCommitRegistry(() => { throw Object.assign(new Error(detail), { stderr: detail, status: 1 }); });
    try { registry.pull(images.standardApp, { anonymous: true }); assert.fail('pull should fail'); }
    catch (error) {
      const failure = publicationFailure(error);
      assert.deepEqual(failure, { operation: 'registry pull', target: [images.standardApp], exitStatus: 1, httpStatus, transportFailure, anonymous: true });
      const report = incompletePublication(acceptCommitPublication(input), { receipt: receipt(), artifact: { id: 80 } }, receipt().producer, 'promote-and-readback', error);
      assert.ok(!JSON.stringify(report).includes('do-not-print'));
      assert.deepEqual(report.failure, failure);
    }
  }
});

const archiveAvailable = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0 && spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
function archiveOf(root, value, extra = false) {
  const directory = fs.mkdtempSync(path.join(root, 'archive-'));
  fs.writeFileSync(path.join(directory, 'candidate.json'), JSON.stringify(value));
  const args = ['-q', 'candidate.zip', 'candidate.json'];
  if (extra) { fs.writeFileSync(path.join(directory, 'unexpected.json'), '{}'); args.push('unexpected.json'); }
  execFileSync('zip', args, { cwd: directory });
  const bytes = fs.readFileSync(path.join(directory, 'candidate.zip'));
  return { bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

test('candidate archive integrity, entry scope and receipt validation use real ZIP bytes', { skip: !archiveAvailable && 'ZIP tools unavailable; Ubuntu publication runner must exercise this consumer' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-receipt-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = archiveOf(root, receipt());
  assert.deepEqual(readCandidateArchive(archive.bytes, archive.digest), receipt());
  assert.throws(() => readCandidateArchive(Buffer.concat([archive.bytes, Buffer.from('tampered')]), archive.digest), /integrity/);
  assert.throws(() => readCandidateArchive(archive.bytes, ''), /integrity/);
  const extra = archiveOf(root, receipt(), true);
  assert.throws(() => readCandidateArchive(extra.bytes, extra.digest), /only candidate.json/);
  const invalid = archiveOf(root, { ...receipt(), tag: 'latest' });
  assert.throws(() => readCandidateArchive(invalid.bytes, invalid.digest), /tag/);
});

test('resume verifies repository/workflow/main provenance, producer success, artifact integrity and real source version', {
  skip: !archiveAvailable && 'ZIP tools unavailable; Ubuntu publication runner must exercise this consumer',
}, t => {
  const f = gitFixture(t), value = receipt();
  value.source.sha = f.sourceSha; value.tag = `commit-${f.sourceSha}`;
  value.producer.toolingSha = value.build.toolingSha = f.toolingSha;
  const archive = archiveOf(f.root, value), root = 'repos/Youzini-afk/Varin/actions';
  const run = { id: 42, run_attempt: 2, workflow_id: 17, path: '.github/workflows/docker-commit.yml',
    event: 'workflow_dispatch', head_branch: 'main', head_sha: f.toolingSha, repository: { full_name: 'Youzini-afk/Varin', id: 19 }, conclusion: 'failure' };
  const artifact = { id: 80, name: 'varin-commit-images-2', digest: archive.digest, expired: false, size_in_bytes: archive.bytes.length,
    workflow_run: { id: 42, repository_id: 19, head_repository_id: 19, head_branch: 'main', head_sha: f.toolingSha } };
  const data = new Map([
    [`${root}/workflows/docker-commit.yml`, { id: 17 }], [`${root}/runs/42`, run],
    [`${root}/runs/42/attempts/2`, run], [`${root}/runs/42/artifacts?per_page=100&page=1`, { artifacts: [artifact] }],
    [`${root}/runs/42/attempts/2/jobs?per_page=100&page=1`, { jobs: [{ id: 77, name: 'Record verified candidate', conclusion: 'success' },
      { name: 'Promote commit images', conclusion: 'failure' }] }],
  ]);
  const adapter = map => ({ json(endpoint) { assert.ok(map.has(endpoint), endpoint); return map.get(endpoint); },
    zip(endpoint) { assert.equal(endpoint, `${root}/artifacts/80/zip`); return archive.bytes; } });
  const selected = { runId: '42', toolingSha: f.toolingSha, sourceSha: f.sourceSha };
  const loaded = loadVerifiedCandidate(selected, adapter(data), f.checkout);
  assert.deepEqual(loaded.receipt, value); assert.equal(loaded.artifact.producerJobId, 77);
  // Overall run failure is expected when only promotion failed; producer success
  // and immutable artifact provenance, not overall green, grant resume.
  const cases = [
    [ `${root}/runs/42`, d => { d.repository.full_name = 'other/Varin'; } ],
    [ `${root}/runs/42`, d => { d.workflow_id = 18; } ],
    [ `${root}/runs/42`, d => { d.path = '.github/workflows/other.yml'; } ],
    [ `${root}/runs/42`, d => { d.event = 'pull_request'; } ],
    [ `${root}/runs/42`, d => { d.head_branch = 'feature'; } ],
    [ `${root}/runs/42/artifacts?per_page=100&page=1`, d => { d.artifacts[0].expired = true; } ],
    [ `${root}/runs/42/artifacts?per_page=100&page=1`, d => { d.artifacts[0].digest = digest('f'); } ],
    [ `${root}/runs/42/artifacts?per_page=100&page=1`, d => { d.artifacts[0].workflow_run.head_sha = f.sourceSha; } ],
    [ `${root}/runs/42/artifacts?per_page=100&page=1`, d => { d.artifacts[0].workflow_run.repository_id = 20; } ],
    [ `${root}/runs/42/artifacts?per_page=100&page=1`, d => { d.artifacts[0].workflow_run.head_repository_id = 20; } ],
    [ `${root}/runs/42/artifacts?per_page=100&page=1`, d => { d.artifacts = []; } ],
    [ `${root}/runs/42/attempts/2`, d => { d.run_attempt = 1; } ],
    [ `${root}/runs/42/attempts/2/jobs?per_page=100&page=1`, d => { d.jobs[0].conclusion = 'failure'; } ],
    [ `${root}/runs/42/attempts/2/jobs?per_page=100&page=1`, d => { d.jobs[0].conclusion = 'skipped'; } ],
    [ `${root}/runs/42/attempts/2/jobs?per_page=100&page=1`, d => { d.jobs.push(d.jobs[0]); } ],
  ];
  for (const [endpoint, mutate] of cases) {
    const changed = new Map([...data].map(([key, v]) => [key, structuredClone(v)])); mutate(changed.get(endpoint));
    assert.throws(() => loadVerifiedCandidate(selected, adapter(changed), f.checkout), undefined, endpoint);
  }
  assert.throws(() => loadVerifiedCandidate({ ...selected, sourceSha: f.toolingSha }, adapter(data), f.checkout), /selected run, attempt or source/);
  const modified = structuredClone(value); modified.source.version = '0.9.39';
  const otherArchive = archiveOf(f.root, modified), changed = new Map([...data].map(([key, v]) => [key, structuredClone(v)]));
  changed.get(`${root}/runs/42/artifacts?per_page=100&page=1`).artifacts[0].digest = otherArchive.digest;
  const otherApi = adapter(changed); otherApi.zip = () => otherArchive.bytes;
  assert.throws(() => loadVerifiedCandidate(selected, otherApi, f.checkout), /source version changed/);
});
