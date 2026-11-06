import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageRegistry, dockerCommand, imageArtifactPlan, imageVersionParts,
  promoteImages, verifyImage, writeAnonymousDockerConfig } from './docker-release.mjs';

const repository = 'Youzini-afk/Varin';
const workflowPath = '.github/workflows/docker-commit.yml';
const artifactPrefix = 'varin-commit-images-';
const producerJob = 'Record verified candidate';
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const prefix = 'ghcr.io/youzini-afk/';
const imageNames = { standardApp: 'varin', toolbeltApp: 'varin-toolbelt',
  slimBase: 'varin-runtime-slim', toolbeltBase: 'varin-runtime-toolbelt' };
const imageRoles = { standardApp: ['application', 'slim'], toolbeltApp: ['application', 'toolbelt'],
  slimBase: ['runtime-base', 'slim'], toolbeltBase: ['runtime-base', 'toolbelt'] };
const sha = value => {
  if (!shaPattern.test(value ?? '')) throw new Error('An exact lowercase 40-character commit SHA is required');
  return value;
};
const id = value => {
  const result = String(value ?? '');
  if (!/^[1-9]\d*$/.test(result) || !Number.isSafeInteger(Number(result))) throw new Error('Invalid GitHub run, attempt or artifact identity');
  return result;
};
const sameRepository = value => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
function operation(name, target, execute, anonymous) {
  try { return execute(); }
  catch (error) {
    // Only extract a status class. Raw buffers may contain signed download URLs
    // or registry authorization details and never belong in public receipts.
    const detail = String(error.stderr ?? '');
    const status = /\bHTTP\s+(\d{3})\b/i.exec(detail)?.[1]
      ?? /\b(401|403|404|408|409|422|429|500|502|503|504)\s+(?:Unauthorized|Forbidden|Not Found|Request Timeout|Conflict|Unprocessable|Too Many|Internal Server|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(detail)?.[1];
    error.publicationOperation = { operation: name, target, exitStatus: Number.isInteger(error.status) ? error.status : null,
      httpStatus: status ? Number(status) : null,
      transportFailure: /timed? ?out|deadline exceeded|connection reset|TLS handshake|ECONNRESET|ENOTFOUND|unexpected EOF/i.test(detail),
      ...(anonymous === undefined ? {} : { anonymous }) };
    throw error;
  }
}
export function publicationFailure(error) {
  const visited = new Set();
  for (let current = error; current && !visited.has(current); current = current.cause) {
    visited.add(current);
    if (current.publicationOperation) return current.publicationOperation;
  }
  return { operation: 'validation', message: error?.message ?? 'Publication could not be verified' };
}
const git = (args, cwd) => operation(`git ${args[0]}`, args.slice(1).join(' '),
  () => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());

export function createCommitRegistry(runDocker) {
  return createImageRegistry((args, options) => {
    const action = args[0] === 'pull' ? 'pull' : args[2];
    const references = action === 'create' ? [args.at(-1), args[args.indexOf('--tag') + 1]] : [action === 'pull' ? args.at(-1) : args[3]];
    return operation(`registry ${action}`, references, () => runDocker(args, options), options?.anonymous === true);
  });
}

export function acceptCommitPublication({ eventName, ref, repository: repo, toolingSha, sourceSha, version }) {
  if (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main' || !sameRepository(repo)) {
    throw new Error('Commit images require a manual workflow dispatched from trusted main in Youzini-afk/Varin');
  }
  sha(toolingSha); sha(sourceSha); imageVersionParts(version);
  return { repository, sourceSha, version, toolingSha, tag: `commit-${sourceSha}` };
}

export function assertAncestor(sourceSha, mainSha, cwd = process.cwd()) {
  for (const value of [sourceSha, mainSha]) {
    sha(value);
    if (git(['cat-file', '-t', value], cwd) !== 'commit') throw new Error('Source and tooling identities must be commits, not tag objects');
  }
  try { git(['merge-base', '--is-ancestor', sourceSha, mainSha], cwd); }
  catch (error) {
    if (error.status === 1) throw new Error(`Selected source ${sourceSha} is not in trusted main history`);
    throw error; // A missing object or transport failure is not an ancestry verdict.
  }
}

export function assertCurrentMain(candidate, cwd = process.cwd()) {
  if (git(['rev-parse', 'HEAD'], cwd) !== candidate.toolingSha) throw new Error('Publication tooling checkout changed');
  const remote = git(['ls-remote', '--refs', 'origin', 'refs/heads/main'], cwd);
  const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(remote);
  if (!match) throw new Error('Could not establish the current main commit');
  git(['fetch', '--no-tags', 'origin', match[1]], cwd);
  assertAncestor(candidate.toolingSha, match[1], cwd);
  assertAncestor(candidate.sourceSha, match[1], cwd);
  return match[1]; // Normal main fast-forwards are allowed; source stays fixed.
}

export function sourceVersion(sourceSha, cwd = process.cwd()) {
  sha(sourceSha);
  const versions = ['package.json', 'packages/ui/package.json', 'packages/web/package.json', 'packages/electron/package.json']
    .map(file => JSON.parse(git(['show', `${sourceSha}:${file}`], cwd)).version);
  imageVersionParts(versions[0]);
  if (new Set(versions).size !== 1) throw new Error('Product, UI, Web and Electron source versions differ');
  return versions[0];
}

function provenance(value) {
  if (!value || typeof value !== 'object') throw new Error('Missing candidate provenance');
  return { runId: id(value.runId), runAttempt: id(value.runAttempt), toolingSha: sha(value.toolingSha) };
}

export function validateCandidateReceipt(receipt) {
  if (!receipt || receipt.schema !== 1 || !sameRepository(receipt.repository) || receipt.workflow !== workflowPath) {
    throw new Error('Invalid commit-image candidate receipt');
  }
  const sourceSha = sha(receipt.source?.sha), version = receipt.source?.version;
  imageVersionParts(version);
  if (receipt.tag !== `commit-${sourceSha}`) throw new Error('Candidate tag does not match its source');
  const producer = provenance(receipt.producer), build = provenance(receipt.build);
  if (producer.runId === build.runId && Number(build.runAttempt) > Number(producer.runAttempt)) throw new Error('Candidate contains a future build attempt');
  if (!receipt.images || Object.keys(receipt.images).sort().join() !== Object.keys(imageNames).sort().join()) {
    throw new Error('Candidate must contain the complete four-image set');
  }
  for (const [key, name] of Object.entries(imageNames)) {
    const reference = receipt.images[key];
    if (typeof reference !== 'string' || !reference.startsWith(`${prefix}${name}@`)
      || !digestPattern.test(reference.slice(`${prefix}${name}@`.length))) throw new Error(`Invalid immutable ${key} candidate`);
  }
  return { schema: 1, repository, workflow: workflowPath, source: { sha: sourceSha, version },
    tag: receipt.tag, producer, build, images: { ...receipt.images } };
}

export function commitImagePlan(receipt) {
  const accepted = validateCandidateReceipt(receipt);
  return imageArtifactPlan(accepted.images, [accepted.tag], new Set([accepted.tag]));
}

function verifyCommitArtifact(image, key, context, registry) {
  const [role, variant] = imageRoles[key];
  const base = key === 'standardApp' ? context.images.slimBase : key === 'toolbeltApp' ? context.images.toolbeltBase : null;
  const observed = { ...registry, config(reference, options) {
    const config = registry.config(reference, options), labels = config?.config?.Labels;
    const expected = { 'org.opencontainers.image.source': `https://github.com/${repository}`,
      'org.opencontainers.image.revision': context.source.sha, 'org.opencontainers.image.version': context.source.version,
      'io.varin.publication.kind': 'commit', 'io.varin.build.run_id': context.build.runId,
      'io.varin.build.tooling_sha': context.build.toolingSha };
    for (const [name, value] of Object.entries(expected)) {
      if (labels?.[name] !== value) throw new Error(`Incorrect ${name} in ${key}: ${reference}`);
    }
    const attempt = id(labels?.['io.varin.build.run_attempt']);
    if (Number(attempt) > Number(context.build.runAttempt)) throw new Error(`Unexpected future build attempt in ${key}`);
    if (base && labels?.['io.varin.image.base'] !== base) throw new Error(`Application does not bind its actual companion base: ${key}`);
    return config;
  } };
  return verifyImage(image, { role, variant }, observed);
}

export function verifyCommitImages(receipt, registry) {
  const accepted = validateCandidateReceipt(receipt);
  for (const key of Object.keys(imageNames)) verifyCommitArtifact(accepted.images[key], key, accepted, registry);
  return accepted;
}

// The artifact digest covers the downloaded ZIP bytes, not a user-supplied JSON
// hash. Never extract paths from the archive. These bounds protect a tiny receipt
// reader from malformed archives/zip bombs; they do not limit product data.
export function readCandidateArchive(archive, expectedDigest) {
  if (!Buffer.isBuffer(archive) || archive.length > 1024 * 1024 || !digestPattern.test(expectedDigest ?? '')
    || `sha256:${createHash('sha256').update(archive).digest('hex')}` !== expectedDigest) {
    throw new Error('Candidate artifact ZIP integrity check failed');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-commit-receipt-'));
  try {
    const file = path.join(temporary, 'candidate.zip'); fs.writeFileSync(file, archive);
    const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 64 * 1024 }).trim().split('\n');
    if (names.length !== 1 || names[0] !== 'candidate.json') throw new Error('Candidate artifact must contain only candidate.json');
    const data = execFileSync('unzip', ['-p', file, 'candidate.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    return validateCandidateReceipt(JSON.parse(data));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function loadVerifiedCandidate({ runId, runAttempt, toolingSha, sourceSha }, api, cwd = process.cwd()) {
  runId = id(runId); sha(toolingSha);
  if (runAttempt) runAttempt = id(runAttempt);
  const root = `repos/${repository}/actions`;
  const workflow = api.json(`${root}/workflows/docker-commit.yml`);
  id(workflow.id);
  const run = api.json(`${root}/runs/${runId}`);
  if (String(run.id) !== runId || run.workflow_id !== workflow.id || run.path !== workflowPath
    || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || !sameRepository(run.repository?.full_name)
    || !Number.isSafeInteger(run.repository?.id)) {
    throw new Error('Resume requires the same repository and main-dispatched Docker Commit Images workflow');
  }
  assertAncestor(sha(run.head_sha), toolingSha, cwd);
  const artifacts = [];
  for (let page = 1; ; page++) {
    const result = api.json(`${root}/runs/${runId}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result.artifacts)) throw new Error('Missing candidate artifact listing');
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
  }
  const candidates = artifacts.filter(item => new RegExp(`^${artifactPrefix}[1-9]\\d*$`).test(item.name))
    .filter(item => !runAttempt || item.name === `${artifactPrefix}${runAttempt}`)
    .sort((a, b) => Number(b.name.slice(artifactPrefix.length)) - Number(a.name.slice(artifactPrefix.length)));
  if (!candidates.length) throw new Error('No saved verified candidate for this run/attempt; do not rebuild over published commit tags');
  const artifact = candidates[0];
  runAttempt = id(artifact.name.slice(artifactPrefix.length));
  if (candidates.filter(item => item.name === artifact.name).length !== 1 || artifact.expired
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0
    || artifact.size_in_bytes > 1024 * 1024 || !digestPattern.test(artifact.digest ?? '')
    || String(artifact.workflow_run?.id) !== runId || artifact.workflow_run?.head_branch !== 'main'
    || artifact.workflow_run?.repository_id !== run.repository.id || artifact.workflow_run?.head_repository_id !== run.repository.id
    || artifact.workflow_run?.head_sha !== run.head_sha) throw new Error('Candidate artifact is expired, ambiguous or has unverified provenance');
  id(artifact.id);
  const attempt = api.json(`${root}/runs/${runId}/attempts/${runAttempt}`);
  if (String(attempt.id) !== runId || String(attempt.run_attempt) !== runAttempt || attempt.head_sha !== run.head_sha
    || attempt.workflow_id !== workflow.id || attempt.path !== workflowPath || attempt.event !== 'workflow_dispatch'
    || attempt.head_branch !== 'main') throw new Error('Candidate run attempt identity changed');
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = api.json(`${root}/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(result.jobs)) throw new Error('Missing candidate producer jobs');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  const producers = jobs.filter(job => job.name === producerJob);
  if (producers.length !== 1 || producers[0].conclusion !== 'success') throw new Error('Candidate producer job did not successfully verify and save the complete set');
  const receipt = readCandidateArchive(api.zip(`${root}/artifacts/${artifact.id}/zip`), artifact.digest);
  if (receipt.producer.runId !== runId || receipt.producer.runAttempt !== runAttempt
    || receipt.producer.toolingSha !== run.head_sha || (sourceSha && receipt.source.sha !== sha(sourceSha))) {
    throw new Error('Saved candidate does not match the selected run, attempt or source');
  }
  assertAncestor(receipt.build.toolingSha, receipt.producer.toolingSha, cwd);
  assertAncestor(receipt.source.sha, receipt.build.toolingSha, cwd);
  if (sourceVersion(receipt.source.sha, cwd) !== receipt.source.version) throw new Error('Saved candidate source version changed');
  return { receipt, artifact: { id: artifact.id, digest: artifact.digest, name: artifact.name,
    runId, runAttempt, producerJobId: producers[0].id } };
}

export function promoteCommitImages(receipt, stageTag, registry) {
  const accepted = verifyCommitImages(receipt, registry), plan = commitImagePlan(accepted);
  promoteImages(plan, stageTag, registry, { verifyStaged(artifacts) {
    // This runs on the promotion job's fresh Docker daemon before any app pull
    // with credentials. Shared layers can be cached between these anonymous
    // pulls; unlike imagetools this really downloads/consumes image layers.
    for (const artifact of artifacts) for (const repository of artifact.repositories) {
      registry.pull(`${repository}@${artifact.digest}`, { anonymous: true });
    }
  } });
  const images = plan.flatMap(artifact => artifact.targets.map(target => {
    if (registry.manifest(target.ref, { anonymous: true })?.digest !== artifact.digest) throw new Error(`Anonymous final tag readback failed: ${target.ref}`);
    return { ref: target.ref, digest: artifact.digest, immutableRef: `${target.ref.split(':')[0]}@${artifact.digest}`,
      role: artifact.role, variant: artifact.variant };
  }));
  return { source: accepted.source, tag: accepted.tag, build: accepted.build, candidateProducer: accepted.producer,
    platforms: ['linux/amd64', 'linux/arm64'], runtimeSmokePlatform: 'linux/amd64', anonymousPullPlatform: 'linux/amd64', images };
}

export function incompletePublication(candidate, saved, publication, phase, error) {
  return { schema: 1, status: 'incomplete', source: { sha: candidate.sourceSha, version: candidate.version },
    phase, publication, artifact: saved?.artifact ?? null,
    expectedImages: saved ? commitImagePlan(saved.receipt).flatMap(image => image.targets.map(target => ({ ref: target.ref, digest: image.digest }))) : null,
    promotionAttemptedInThisJob: phase === 'promote-and-readback',
    registryState: 'unknown-until-reconciled',
    failure: error ? publicationFailure(error) : null,
    recovery: 'Earlier writes may exist. Resume the original verified candidate digests; never rebuild or overwrite frozen commit tags.' };
}

const api = {
  json(endpoint) { return operation('GitHub GET metadata', endpoint,
    () => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))); },
  zip(endpoint) { return operation('GitHub GET candidate archive', endpoint,
    () => execFileSync('gh', ['api', endpoint], { maxBuffer: 1024 * 1024 })); },
};
const output = values => {
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(String(value))) throw new Error('Invalid multiline workflow output');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
};
function githubContext(sourceSha, version) {
  const candidate = acceptCommitPublication({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY, toolingSha: process.env.GITHUB_SHA, sourceSha, version });
  if (git(['rev-parse', 'HEAD']) !== candidate.toolingSha) throw new Error('Use the dispatch main tooling checkout, not the selected product checkout');
  assertAncestor(candidate.sourceSha, candidate.toolingSha);
  return candidate;
}
function currentProvenance() {
  return { runId: id(process.env.GITHUB_RUN_ID), runAttempt: id(process.env.GITHUB_RUN_ATTEMPT), toolingSha: sha(process.env.GITHUB_SHA) };
}
function selectedBuild() {
  return provenance({ runId: process.env.BUILD_RUN_ID, runAttempt: process.env.BUILD_RUN_ATTEMPT, toolingSha: process.env.BUILD_TOOLING_SHA });
}

function runCli() {
  const command = process.argv[2];
  if (command === 'accept') {
    // Validate the dispatch boundary before downloading any caller-selected run.
    githubContext(process.env.GITHUB_SHA, sourceVersion(process.env.GITHUB_SHA));
    const runId = process.env.INPUT_RESUME_RUN_ID, runAttempt = process.env.INPUT_RESUME_RUN_ATTEMPT;
    if (runAttempt && !runId) throw new Error('resume_run_attempt requires resume_run_id');
    const selected = runId ? loadVerifiedCandidate({ runId, runAttempt, toolingSha: process.env.GITHUB_SHA,
      sourceSha: process.env.INPUT_SOURCE_SHA || undefined }, api) : null;
    const sourceSha = process.env.INPUT_SOURCE_SHA || selected?.receipt.source.sha || process.env.GITHUB_SHA;
    const candidate = githubContext(sourceSha, sourceVersion(sourceSha));
    assertCurrentMain(candidate);
    const build = selected?.receipt.build ?? currentProvenance(), images = selected?.receipt.images ?? {};
    output({ source_sha: candidate.sourceSha, version: candidate.version, mode: selected ? 'resume' : 'build',
      build_run_id: build.runId, build_tooling_sha: build.toolingSha, build_run_attempt: build.runAttempt,
      standard_app: images.standardApp ?? '', toolbelt_app: images.toolbeltApp ?? '', slim_base: images.slimBase ?? '', toolbelt_base: images.toolbeltBase ?? '' });
    console.log(`Accepted ${candidate.tag}; source ${sourceSha}; tooling ${candidate.toolingSha}; ${selected ? `resume ${runId}/${selected.artifact.runAttempt}` : 'build new candidates'}`);
  } else if (command === 'resolve-base') {
    const candidate = githubContext(process.env.SOURCE_SHA, process.env.SOURCE_VERSION);
    const variant = process.argv[3], key = variant === 'slim' ? 'slimBase' : variant === 'toolbelt' ? 'toolbeltBase' : null;
    if (!key) throw new Error('Choose slim or toolbelt');
    const reference = process.env.BASE_IMAGE;
    if (!reference?.startsWith(`${prefix}${imageNames[key]}@`) || !digestPattern.test(reference.split('@')[1] ?? '')) throw new Error('Build must consume its fixed commit runtime base');
    verifyCommitArtifact(reference, key, { source: { sha: candidate.sourceSha, version: candidate.version }, build: selectedBuild(), images: {} }, createCommitRegistry(dockerCommand()));
    output({ image: reference });
  } else if (command === 'record') {
    const candidate = githubContext(process.env.SOURCE_SHA, process.env.SOURCE_VERSION);
    if (!['build', 'resume'].includes(process.env.PUBLICATION_MODE)) throw new Error('Invalid publication mode');
    if (sourceVersion(candidate.sourceSha) !== candidate.version) throw new Error('Source version mismatch');
    assertCurrentMain(candidate);
    const producer = currentProvenance(), build = process.env.PUBLICATION_MODE === 'resume' ? selectedBuild() : producer;
    const receipt = verifyCommitImages({ schema: 1, repository, workflow: workflowPath, tag: candidate.tag,
      source: { sha: candidate.sourceSha, version: candidate.version }, producer, build,
      images: { standardApp: process.env.STANDARD_APP_IMAGE, toolbeltApp: process.env.TOOLBELT_APP_IMAGE,
        slimBase: process.env.SLIM_BASE_IMAGE, toolbeltBase: process.env.TOOLBELT_BASE_IMAGE } }, createCommitRegistry(dockerCommand()));
    const directory = 'artifacts/commit-images'; fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(`${directory}/candidate.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    output({ artifact_name: `${artifactPrefix}${producer.runAttempt}`, artifact_attempt: producer.runAttempt });
    console.log(`Verified four digests for ${candidate.tag}; save the candidate artifact before promotion`);
  } else if (command === 'promote') {
    const candidate = githubContext(process.env.SOURCE_SHA, process.env.SOURCE_VERSION);
    const publication = currentProvenance();
    let saved, temporary, phase = 'verify-candidate';
    const save = report => {
      fs.mkdirSync('artifacts/commit-images', { recursive: true });
      fs.writeFileSync('artifacts/commit-images/publication.json', `${JSON.stringify(report, null, 2)}\n`);
    };
    try {
      saved = loadVerifiedCandidate({ runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.CANDIDATE_RUN_ATTEMPT,
        toolingSha: candidate.toolingSha, sourceSha: candidate.sourceSha }, api);
      if (saved.receipt.source.version !== candidate.version) throw new Error('Candidate/source version mismatch');
      assertCurrentMain(candidate);
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-commit-anonymous-'));
      writeAnonymousDockerConfig(temporary);
      phase = 'promote-and-readback';
      const result = promoteCommitImages(saved.receipt, `candidate-${publication.runId}-${publication.runAttempt}`,
        createCommitRegistry(dockerCommand(temporary)));
      const report = { schema: 1, status: 'complete', ...result, artifact: saved.artifact, publication };
      save(report);
      console.log(JSON.stringify(report, null, 2));
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Published commit images\n\nSource: ${candidate.sourceSha}\n\nAll six immutable tags verified. Both architectures inspected; actual app smoke and anonymous pulls: linux/amd64.\n\n`
        + result.images.map(item => `- \`${item.ref}\` → \`${item.digest}\``).join('\n') + '\n');
    } catch (error) {
      save(incompletePublication(candidate, saved, publication, phase, error));
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Commit image publication incomplete\n\nSource: ${candidate.sourceSha}\n\nStopped during ${phase}. Earlier writes may exist. Reconcile and resume the original verified digest set; do not rebuild or overwrite frozen tags. See the publication outcome artifact.\n`);
      throw error;
    } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  } else throw new Error('Usage: docker-commit.mjs accept|resolve-base <slim|toolbelt>|record|promote');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); }
  catch (error) {
    // Child-process failures can include signed artifact download URLs. Keep
    // those buffers/causes out of public Actions logs and outcome artifacts.
    console.error(JSON.stringify(publicationFailure(error)));
    process.exitCode = 1;
  }
}
