import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptImageRelease, assertImageReleaseTag } from './docker-release.mjs';
import { assertAncestor, sourceVersion } from './docker-commit.mjs';

const repository = 'Youzini-afk/Varin';
const workflow = '.github/workflows/docker.yml';
const artifactPrefix = 'varin-container-build-';
const imageNames = { standard_app: 'varin', toolbelt_app: 'varin-toolbelt',
  slim_base: 'varin-runtime-slim', toolbelt_base: 'varin-runtime-toolbelt' };
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const id = value => {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('Invalid Actions run or attempt');
  return text;
};
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function resolveImageRelease(env, cwd = process.cwd()) {
  if (env.GITHUB_REPOSITORY?.toLowerCase() !== repository.toLowerCase()) throw new Error('Unexpected image publication repository');
  const ref = env.INPUT_RELEASE_REF ? `refs/tags/${env.INPUT_RELEASE_REF}` : env.GITHUB_REF;
  if (!/^refs\/tags\/v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(ref ?? '')) throw new Error('Select a release tag');
  if (ref !== env.GITHUB_REF && (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main')) {
    throw new Error('Selecting another release requires dispatch from main');
  }
  const source = git(['rev-parse', `${ref}^{commit}`], cwd);
  if (!sha.test(env.GITHUB_SHA ?? '') || git(['rev-parse', 'HEAD'], cwd) !== env.GITHUB_SHA) throw new Error('Publication tooling checkout changed');
  if (source !== env.GITHUB_SHA && !(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main')) {
    throw new Error('Historical release tooling must be dispatched from main');
  }
  assertAncestor(source, env.GITHUB_SHA, cwd);
  const candidate = acceptImageRelease({ eventName: env.GITHUB_EVENT_NAME, ref, sha: source, version: sourceVersion(source, cwd) });
  assertImageReleaseTag(candidate, cwd);
  return candidate;
}

export function validateReleaseBuild(result, candidate, toolingSha) {
  if (result?.sourceSha !== candidate.sha || result.toolingSha !== toolingSha
    || !Array.isArray(result.platforms) || [...result.platforms].sort().join() !== 'linux/amd64,linux/arm64'
    || Object.keys(result.images ?? {}).sort().join() !== Object.keys(imageNames).sort().join()) {
    throw new Error('Saved image build does not match this release and both Linux architectures');
  }
  for (const [key, reference] of Object.entries(result.images)) {
    if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error(`Missing immutable ${key} digest`);
    if (key.endsWith('_app') && !reference.startsWith(`ghcr.io/youzini-afk/${imageNames[key]}@`)) throw new Error(`Unexpected ${key} repository`);
  }
  return result.images;
}

// Read only the fixed report entry; archive paths are never extracted. Other
// entries are the original builder's bake/metadata reports, not product files.
export function readReleaseBuildArchive(bytes, expectedDigest) {
  if (!Buffer.isBuffer(bytes) || !digest.test(expectedDigest ?? '')
    || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expectedDigest) throw new Error('Build artifact integrity mismatch');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-release-build-'));
  try {
    const file = path.join(directory, 'build.zip'); fs.writeFileSync(file, bytes);
    const windows = process.platform === 'win32';
    const names = execFileSync(windows ? 'tar' : 'unzip', windows ? ['-tf', file] : ['-Z1', file], { encoding: 'utf8' }).trim().split(/\r?\n/);
    if (names.filter(name => name === 'result.json').length !== 1) throw new Error('Build artifact must contain one result.json');
    return JSON.parse(execFileSync(windows ? 'tar' : 'unzip', windows ? ['-xOf', file, 'result.json'] : ['-p', file, 'result.json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function loadReleaseBuild({ runId, runAttempt, candidate, toolingSha }, api, cwd = process.cwd()) {
  runId = id(runId);
  if (runAttempt) runAttempt = id(runAttempt);
  const root = `repos/${repository}/actions`;
  const definition = api.json(`${root}/workflows/docker.yml`);
  const run = api.json(`${root}/runs/${runId}`);
  if (String(run.id) !== runId || run.workflow_id !== definition.id || run.path !== workflow
    || run.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
    || !sha.test(run.head_sha ?? '') || !['push', 'workflow_dispatch'].includes(run.event)
    || ![candidate.ref.slice('refs/tags/'.length), 'main'].includes(run.head_branch)
    || (run.event === 'push' && run.head_branch === 'main')) throw new Error('Resume requires an original Docker release build');
  assertAncestor(run.head_sha, toolingSha, cwd);
  const collect = (url, key) => {
    const items = [];
    for (let page = 1; ; page++) {
      const response = api.json(`${url}?per_page=100&page=${page}`);
      if (!Array.isArray(response[key])) throw new Error(`Missing Actions ${key}`);
      items.push(...response[key]); if (response[key].length < 100) return items;
    }
  };
  const artifacts = collect(`${root}/runs/${runId}/artifacts`, 'artifacts')
    .filter(item => /^varin-container-build-[1-9]\d*$/.test(item.name))
    .filter(item => !runAttempt || item.name === `${artifactPrefix}${runAttempt}`)
    .sort((a, b) => Number(b.name.slice(artifactPrefix.length)) - Number(a.name.slice(artifactPrefix.length)));
  const requestedAttempt = runAttempt;
  let artifact;
  for (const item of artifacts) {
    const number = id(item.name.slice(artifactPrefix.length));
    const attempt = api.json(`${root}/runs/${runId}/attempts/${number}`);
    if (String(attempt.id) !== runId || String(attempt.run_attempt) !== number || attempt.head_sha !== run.head_sha
      || attempt.workflow_id !== definition.id || attempt.path !== workflow) throw new Error('Build attempt identity changed');
    const builders = collect(`${root}/runs/${runId}/attempts/${number}/jobs`, 'jobs')
      .filter(job => job.name === 'Build release image candidates / Build shared immutable image graph');
    if (builders.length !== 1) throw new Error('Missing or ambiguous original image builder');
    if (builders[0].conclusion === 'success') { artifact = item; runAttempt = number; break; }
    if (requestedAttempt) throw new Error('Original image builder did not succeed');
  }
  if (!artifact || artifacts.filter(item => item.name === artifact.name).length !== 1 || artifact.expired
    || !digest.test(artifact.digest ?? '') || String(artifact.workflow_run?.id) !== runId
    || artifact.workflow_run?.head_sha !== run.head_sha
    || artifact.workflow_run?.repository_id !== run.repository.id || artifact.workflow_run?.head_repository_id !== run.repository.id) {
    throw new Error('No intact build artifact from the selected release run/attempt');
  }
  const result = readReleaseBuildArchive(api.zip(`${root}/artifacts/${id(artifact.id)}/zip`), artifact.digest);
  const images = validateReleaseBuild(result, candidate, run.head_sha);
  return { images, runId, runAttempt, toolingSha: run.head_sha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env, candidate = resolveImageRelease(env);
    if (env.INPUT_RESUME_RUN_ATTEMPT && !env.INPUT_RESUME_RUN_ID) throw new Error('Resume attempt requires a run');
    if (env.INPUT_RESUME_RUN_ID && (env.INPUT_SLIM_BASE || env.INPUT_TOOLBELT_BASE)) throw new Error('Resume retains the original bases; do not supply new overrides');
    const gh = (endpoint, binary = false) => {
      try { return execFileSync('gh', ['api', endpoint], { encoding: binary ? undefined : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
      catch { throw new Error(`GitHub could not read ${endpoint}`); }
    };
    const restored = env.INPUT_RESUME_RUN_ID ? loadReleaseBuild({ runId: env.INPUT_RESUME_RUN_ID,
      runAttempt: env.INPUT_RESUME_RUN_ATTEMPT, candidate, toolingSha: env.GITHUB_SHA },
    { json: endpoint => JSON.parse(gh(endpoint)), zip: endpoint => gh(endpoint, true) }) : null;
    const outputs = { source_sha: candidate.sha, version: candidate.version, release_ref: candidate.ref,
      mode: restored ? 'resume' : 'build', ...restored?.images,
      build_run_id: restored?.runId ?? '', build_run_attempt: restored?.runAttempt ?? '', build_tooling_sha: restored?.toolingSha ?? '' };
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`Accepted ${candidate.ref} at ${candidate.sha}; ${restored ? `reuse build ${restored.runId}/${restored.runAttempt}` : 'build candidates'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
