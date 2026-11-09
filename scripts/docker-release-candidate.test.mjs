import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadReleaseBuild, readReleaseBuildArchive, resolveImageRelease, validateReleaseBuild } from './docker-release-candidate.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-release-resume-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Release fixture', '-c', 'user.email=release@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  for (const file of ['package.json', 'packages/ui/package.json', 'packages/web/package.json', 'packages/electron/package.json']) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), JSON.stringify({ version: '0.9.42' }));
  }
  git('add', '.'); git('commit', '--quiet', '-m', 'Product source');
  const source = git('rev-parse', 'HEAD'); git('tag', 'v0.9.42');
  git('commit', '--quiet', '--allow-empty', '-m', 'Current tooling');
  const tooling = git('rev-parse', 'HEAD'); git('remote', 'add', 'origin', cwd);
  const env = { GITHUB_REPOSITORY: 'Youzini-afk/Varin', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: tooling, INPUT_RELEASE_REF: 'v0.9.42' };
  const candidate = resolveImageRelease(env, cwd);
  const images = Object.fromEntries(['standard_app', 'toolbelt_app', 'slim_base', 'toolbelt_base'].map((key, index) =>
    [key, `ghcr.io/youzini-afk/${['varin', 'varin-toolbelt', 'varin-runtime-slim', 'varin-runtime-toolbelt'][index]}@sha256:${String(index + 1).repeat(64)}`]));
  const result = { sourceSha: source, toolingSha: source, platforms: ['linux/amd64', 'linux/arm64'], images };
  return { cwd, git, source, tooling, env, candidate, result, images };
}

test('current main tooling selects the original release source without moving its tag', t => {
  const f = fixture(t);
  assert.equal(f.candidate.sha, f.source); assert.equal(f.candidate.version, '0.9.42');
  assert.equal(f.git('rev-parse', 'v0.9.42'), f.source);
  f.git('checkout', '--quiet', '--detach', f.source);
  assert.equal(resolveImageRelease({ ...f.env, INPUT_RELEASE_REF: '', GITHUB_REF: f.candidate.ref, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: f.source }, f.cwd).sha, f.source);
  f.git('checkout', '--quiet', 'main');
  for (const patch of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { INPUT_RELEASE_REF: 'main' }, { GITHUB_REPOSITORY: 'other/Varin' }, { GITHUB_SHA: f.source }]) {
    assert.throws(() => resolveImageRelease({ ...f.env, ...patch }, f.cwd));
  }
});

test('saved builds retain both architectures, exact source and immutable application repositories', t => {
  const f = fixture(t);
  assert.deepEqual(validateReleaseBuild(f.result, f.candidate, f.source), f.images);
  for (const patch of [{ sourceSha: f.tooling }, { toolingSha: f.tooling }, { platforms: ['linux/amd64'] },
    { images: { ...f.images, standard_app: 'ghcr.io/youzini-afk/varin:latest' } },
    { images: { ...f.images, standard_app: f.images.standard_app.replace('/varin@', '/other@') } }]) {
    assert.throws(() => validateReleaseBuild({ ...f.result, ...patch }, f.candidate, f.source));
  }
});

test('resume reads the original successful builder, not overall run status or a later failed attempt', t => {
  const f = fixture(t), archive = path.join(f.cwd, 'build.zip');
  fs.writeFileSync(path.join(f.cwd, 'result.json'), JSON.stringify(f.result));
  // Python's standard ZIP writer avoids depending on a platform-specific archiver.
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipfile', '-c', archive, 'result.json'], { cwd: f.cwd });
  const bytes = fs.readFileSync(archive), hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.deepEqual(readReleaseBuildArchive(bytes, hash), f.result);
  assert.throws(() => readReleaseBuildArchive(Buffer.concat([bytes, Buffer.from('changed')]), hash), /integrity/);
  const root = 'repos/Youzini-afk/Varin/actions';
  const run = { id: 42, workflow_id: 17, path: '.github/workflows/docker.yml', event: 'push',
    head_branch: 'v0.9.42', head_sha: f.source, repository: { full_name: 'Youzini-afk/Varin', id: 19 }, conclusion: 'failure' };
  const artifact = { id: 80, name: 'varin-container-build-1', digest: hash, expired: false,
    workflow_run: { id: 42, head_sha: f.source, repository_id: 19, head_repository_id: 19 } };
  const data = new Map([
    [`${root}/workflows/docker.yml`, { id: 17 }], [`${root}/runs/42`, run],
    [`${root}/runs/42/artifacts?per_page=100&page=1`, { artifacts: [artifact, { ...artifact, id: 81, name: 'varin-container-build-2' }] }],
    [`${root}/runs/42/attempts/1`, { ...run, run_attempt: 1 }],
    [`${root}/runs/42/attempts/1/jobs?per_page=100&page=1`, { jobs: [
      { name: 'Build release image candidates / Build shared immutable image graph', conclusion: 'success' },
      { name: 'Qualify exact release source / Windows runtime', conclusion: 'failure' }] }],
    [`${root}/runs/42/attempts/2`, { ...run, run_attempt: 2 }],
    [`${root}/runs/42/attempts/2/jobs?per_page=100&page=1`, { jobs: [
      { name: 'Build release image candidates / Build shared immutable image graph', conclusion: 'failure' }] }],
  ]);
  const api = map => ({ json: endpoint => { assert(map.has(endpoint), endpoint); return map.get(endpoint); },
    zip: endpoint => { assert.equal(endpoint, `${root}/artifacts/80/zip`); return bytes; } });
  const input = { runId: '42', candidate: f.candidate, toolingSha: f.tooling };
  assert.deepEqual(loadReleaseBuild(input, api(data), f.cwd), { images: f.images, runId: '42', runAttempt: '1', toolingSha: f.source });
  assert.throws(() => loadReleaseBuild({ ...input, runAttempt: '2' }, api(data), f.cwd), /did not succeed/);
  for (const [endpoint, mutate] of [
    [`${root}/runs/42`, value => { value.event = 'pull_request'; }],
    [`${root}/runs/42`, value => { value.workflow_id = 18; }],
    [`${root}/runs/42/artifacts?per_page=100&page=1`, value => { value.artifacts[0].expired = true; }],
    [`${root}/runs/42/artifacts?per_page=100&page=1`, value => { value.artifacts[0].workflow_run.head_sha = f.tooling; }],
    [`${root}/runs/42/attempts/1/jobs?per_page=100&page=1`, value => { value.jobs[0].conclusion = 'failure'; }],
  ]) {
    const changed = new Map([...data].map(([key, value]) => [key, structuredClone(value)])); mutate(changed.get(endpoint));
    assert.throws(() => loadReleaseBuild(input, api(changed), f.cwd));
  }
});
