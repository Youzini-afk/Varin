import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v0.9.38 was already published with varin=toolbelt. This publisher never
// reinterprets that release, its prereleases, or any older exact/SHA tags.
const legacyVersion = '0.9.38';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const registryPrefix = 'ghcr.io/youzini-afk/';
const indexTypes = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);

function versionParts(version) {
  const match = versionPattern.exec(version ?? '');
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return match.slice(1);
}
export { versionParts as imageVersionParts };
function compareCore(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
  }
  return 0;
}
function pinnedImage(image) {
  const match = /^([a-z0-9][a-z0-9._:/-]*)@(sha256:[a-f0-9]{64})$/.exec(image ?? '');
  if (!match || match[1].split('/').at(-1).includes(':')) throw new Error(`Expected an immutable image repository@sha256 digest: ${image}`);
  return { repository: match[1], digest: match[2] };
}

export function acceptImageRelease({ eventName, ref, sha, version }) {
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Image publication requires a release event');
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Image publication requires an exact source SHA');
  const parts = versionParts(version);
  if (ref !== `refs/tags/v${version}`) throw new Error('Select a v<package version> release tag, not a branch');
  if (compareCore(version, legacyVersion) <= 0) throw new Error(`The new image contract requires a release newer than ${legacyVersion}; historical images are immutable`);
  const aliases = parts[3] ? [version] : [version, `${parts[0]}.${parts[1]}`, parts[0], 'latest'];
  aliases.push(`sha-${sha}`);
  return { ref, sha, version, aliases };
}

export function assertImageReleaseTag(candidate, cwd = process.cwd()) {
  // Read all release refs under the promotion lock as well as at admission.
  // Retained Git release tags, not reused base-image version labels, order releases.
  const output = execFileSync('git', ['ls-remote', '--tags', 'origin'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const byRef = new Map(output.trim().split('\n').filter(Boolean).map(line => {
    const [sha, ref] = line.split(/\s+/);
    return [ref, sha];
  }));
  const current = byRef.get(`${candidate.ref}^{}`) ?? byRef.get(candidate.ref);
  if (current !== candidate.sha) throw new Error('The release tag moved after this candidate was selected');
  return [...byRef.keys()];
}

export function releaseImageAliases(candidate, releaseRefs) {
  if (!releaseRefs.includes(candidate.ref)) throw new Error('Missing remote release-tag evidence');
  const immutable = [candidate.version, `sha-${candidate.sha}`];
  if (versionParts(candidate.version)[3]) return immutable;
  // Conservative complete-set rule: once a newer stable tag exists, historical
  // releases cannot change ANY floats, even if a newer promotion stopped midway.
  for (const ref of releaseRefs) {
    const version = ref.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : '';
    if (!versionPattern.test(version)) continue;
    const parts = versionParts(version);
    if (!parts[3] && compareCore(version, candidate.version) > 0) return immutable;
  }
  return candidate.aliases;
}

export function imagePromotionPlan(candidate, { standardApp, toolbeltApp, slimBase, toolbeltBase }, releaseRefs) {
  const aliases = releaseImageAliases(candidate, releaseRefs);
  return imageArtifactPlan({ standardApp, toolbeltApp, slimBase, toolbeltBase }, aliases,
    new Set([candidate.version, `sha-${candidate.sha}`]));
}

// Both publication channels share the artifact/compatibility-name owner. Their
// admission and alias policies remain separate; this function grants neither.
export function imageArtifactPlan({ standardApp, toolbeltApp, slimBase, toolbeltBase }, aliases, immutableAliases) {
  const images = [
    [standardApp, 'application', 'slim', ['varin', 'varin-slim']],
    [toolbeltApp, 'application', 'toolbelt', ['varin-toolbelt']],
    [slimBase, 'runtime-base', 'slim', ['varin-runtime-slim']],
    [toolbeltBase, 'runtime-base', 'toolbelt', ['varin-runtime-toolbelt', 'varin-runtime-base']],
  ];
  return images.map(([source, role, variant, names]) => {
    const { digest } = pinnedImage(source);
    const repositories = names.map(name => `${registryPrefix}${name}`);
    return { source, digest, role, variant, repositories, targets: repositories.flatMap(repository => aliases.map(alias => ({
      ref: `${repository}:${alias}`, immutable: immutableAliases.has(alias),
    }))) };
  });
}

// The CLI reports an absent tag as "<exact reference>: not found". Only accept
// that precise absence (or MANIFEST_UNKNOWN), never generic 403/auth/transport
// errors. Callers permit absence only after proving the target repository exists.
export function createImageRegistry(runDocker) {
  const inspect = (reference, field, options = {}) => {
    try {
      const value = JSON.parse(runDocker(['buildx', 'imagetools', 'inspect', reference, '--format', `{{json .${field}}}`], options));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid registry ${field} for ${reference}`);
      return value;
    } catch (error) {
      const detail = String(error.stderr ?? '').trim().replace(/^ERROR:\s*/, '');
      if (options.allowMissing && (detail === `${reference}: not found`
        || detail === `${reference}: manifest unknown` || detail === `${reference}: MANIFEST_UNKNOWN`)) return null;
      throw error;
    }
  };
  return {
    manifest(reference, options) {
      const value = inspect(reference, 'Manifest', options);
      if (value !== null && !digestPattern.test(value.digest ?? '')) throw new Error(`Invalid registry descriptor for ${reference}`);
      return value;
    },
    config: (reference, options) => inspect(reference, 'Image', options),
    copy(source, target) {
      runDocker(['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', target, source]);
    },
    pull(reference, options) {
      runDocker(['pull', '--platform', 'linux/amd64', reference], options);
    },
  };
}

export function verifyImage(image, { role, variant }, registry, options = {}) {
  const { repository, digest } = pinnedImage(image);
  const manifest = registry.manifest(image, options);
  if (manifest?.digest !== digest || !indexTypes.has(manifest.mediaType) || !Array.isArray(manifest.manifests)) {
    throw new Error(`Expected the unchanged multi-platform image index: ${image}`);
  }
  const platforms = new Set();
  for (const child of manifest.manifests) {
    if (!digestPattern.test(child.digest ?? '')) throw new Error(`Invalid platform digest in ${image}`);
    if (child.platform?.os === 'unknown' && child.platform?.architecture === 'unknown'
      && child.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') continue;
    const architecture = child.platform?.architecture;
    const variantAllowed = !child.platform?.variant || (architecture === 'arm64' && child.platform.variant === 'v8');
    if (child.platform?.os !== 'linux' || !['amd64', 'arm64'].includes(architecture) || !variantAllowed || platforms.has(architecture)) {
      throw new Error(`Unexpected or duplicate platform in ${image}`);
    }
    platforms.add(architecture);
    const config = registry.config(`${repository}@${child.digest}`, options);
    if (config?.os !== 'linux' || config.architecture !== architecture
      || config.config?.Labels?.['io.varin.image.role'] !== role
      || config.config?.Labels?.['io.varin.image.variant'] !== variant
      || config.config?.Env?.filter(value => value.startsWith('VARIN_IMAGE_VARIANT=')).at(-1) !== `VARIN_IMAGE_VARIANT=${variant}`) {
      throw new Error(`Expected ${role}/${variant} metadata for linux/${architecture}: ${image}`);
    }
  }
  if (platforms.size !== 2) throw new Error(`Both linux/amd64 and linux/arm64 are required: ${image}`);
  return image;
}

export function resolveRuntimeBase(reference, variant, registry) {
  if (!['slim', 'toolbelt'].includes(variant) || !/^[a-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/.test(reference ?? '')) {
    throw new Error('Select a valid runtime-base image reference and variant');
  }
  const manifest = registry.manifest(reference);
  let repository = reference.split('@')[0];
  if (repository.split('/').at(-1).includes(':')) repository = repository.slice(0, repository.lastIndexOf(':'));
  const image = `${repository}@${manifest.digest}`;
  if (reference.includes('@') && reference.split('@')[1] !== manifest.digest) throw new Error('Resolved base digest changed');
  return verifyImage(image, { role: 'runtime-base', variant }, registry);
}

export function promoteImages(plan, stageTag, registry, {
  verifyStaged = () => {}, replaceVersion,
  wait = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  if (!/^candidate-\d+-\d+$/.test(stageTag)) throw new Error('Promotion requires this run’s unique candidate tag');
  if (replaceVersion !== undefined) versionParts(replaceVersion);
  const desired = new Map();
  for (const artifact of plan) {
    if (pinnedImage(artifact.source).digest !== artifact.digest) throw new Error('Source digest does not match promotion plan');
    for (const target of artifact.targets) {
      if (desired.has(target.ref)) throw new Error(`Duplicate promotion destination: ${target.ref}`);
      desired.set(target.ref, artifact.digest);
    }
    verifyImage(artifact.source, artifact, registry);
  }
  const confirm = (target, digest) => {
    // GHCR can acknowledge a tag write before its read endpoint sees the tag.
    // Re-read that exact tag; never repeat the write or accept a different digest.
    for (const delay of [0, 1000, 2000, 4000, 8000]) {
      if (delay) wait(delay);
      const manifest = registry.manifest(target, { allowMissing: true });
      if (!manifest) continue;
      if (manifest.digest !== digest) throw new Error(`Registry copy did not preserve the verified digest: ${target}`);
      return;
    }
    throw new Error(`Registry acknowledged the copy but the tag is still not visible: ${target}. Retry promotion to complete the existing publication.`);
  };
  const copy = (source, target, digest) => {
    registry.copy(source, target);
    confirm(target, digest);
  };
  // Candidate-only writes establish new packages, including explicitly selected
  // base overrides. No exact version, SHA or floating release tag changes yet.
  for (const artifact of plan) for (const repository of artifact.repositories) {
    copy(artifact.source, `${repository}:${stageTag}`, artifact.digest);
  }
  for (const artifact of plan) for (const repository of artifact.repositories) {
    try {
      verifyImage(`${repository}@${artifact.digest}`, artifact, registry, { anonymous: true });
    } catch (error) {
      throw new Error(`Anonymous pull access failed for ${repository}@${artifact.digest}. The package owner must enable intended public access, then retry promotion; no release aliases were changed.`, { cause: error });
    }
  }
  // A channel may require additional real consumption (e.g. anonymous Docker
  // pulls on a fresh runner) before any immutable or floating tag changes.
  verifyStaged(plan);
  // Complete-plan preflight, including every alias repository. Unknown lookup
  // outcomes fail closed. Identical partial publication can be retried safely.
  const writes = [];
  for (const artifact of plan) for (const target of artifact.targets) {
    const existing = registry.manifest(target.ref, { allowMissing: true });
    if (existing?.digest === artifact.digest) continue;
    const replaceSelectedVersion = replaceVersion !== undefined && target.ref.endsWith(`:${replaceVersion}`);
    if (existing && target.immutable && !replaceSelectedVersion) throw new Error(`Refusing to replace immutable image tag ${target.ref}`);
    writes.push({ ...target, source: artifact.source, digest: artifact.digest });
  }
  // Freeze the complete exact release before advancing any mutable alias.
  for (const immutable of [true, false]) for (const write of writes.filter(item => item.immutable === immutable)) {
    copy(write.source, write.ref, write.digest);
  }
  for (const artifact of plan) for (const target of artifact.targets) {
    confirm(target.ref, artifact.digest);
  }
}

export function dockerCommand(anonymousDirectory) {
  return (args, { anonymous = false } = {}) => execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    env: anonymous ? { ...process.env, DOCKER_CONFIG: anonymousDirectory, DOCKER_AUTH_CONFIG: '' } : process.env,
  });
}

export function writeAnonymousDockerConfig(directory, existingDirectory = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker')) {
  // Docker detects a platform credential helper when ContainsAuth() is false.
  // A named but empty GHCR record prevents that fallback without supplying any
  // credentials; auths:{} would not actually guarantee an anonymous probe.
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    auths: { 'ghcr.io': {} }, cliPluginsExtraDirs: [path.join(existingDirectory, 'cli-plugins')],
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!['accept', 'resolve-base', 'promote'].includes(command)) throw new Error('Usage: docker-release.mjs accept|resolve-base <slim|toolbelt>|promote');
  const candidate = acceptImageRelease({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA, version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version });
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (checkedOut !== candidate.sha) throw new Error('Checkout does not match the release candidate SHA');
  const releaseRefs = assertImageReleaseTag(candidate);
  if (command === 'accept') {
    console.log(`Accepted ${candidate.ref} at ${candidate.sha}`);
  } else if (command === 'resolve-base') {
    const registry = createImageRegistry(dockerCommand());
    const image = resolveRuntimeBase(process.env.BASE_OVERRIDE || `${process.env.BASE_REPOSITORY}@${process.env.BASE_DIGEST}`, process.argv[3], registry);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  } else {
    const plan = imagePromotionPlan(candidate, { standardApp: process.env.VARIN_STANDARD_APP_IMAGE, toolbeltApp: process.env.VARIN_TOOLBELT_APP_IMAGE,
      slimBase: process.env.VARIN_SLIM_BASE_IMAGE, toolbeltBase: process.env.VARIN_TOOLBELT_BASE_IMAGE }, releaseRefs);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-anonymous-registry-'));
    try {
      // Preserve only plugin discovery, never auths/credential helpers from the
      // logged-in config. Imagetools reads both platform manifests/configs.
      writeAnonymousDockerConfig(directory);
      const replaceVersion = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.VARIN_REPLACE_VERSION === 'true'
        ? candidate.version : undefined;
      promoteImages(plan, `candidate-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`, createImageRegistry(dockerCommand(directory)), { replaceVersion });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
