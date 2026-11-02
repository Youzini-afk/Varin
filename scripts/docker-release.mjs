import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Image publication is a release operation, never a side effect of a main push
// or a manual branch build. Both entrypoints accept the same immutable source.
export function acceptImageRelease({ eventName, ref, sha, version }) {
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Image publication requires a release event');
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Image publication requires an exact source SHA');
  const match = /^refs\/tags\/v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/.exec(ref ?? '');
  if (!match || match[1] !== version) throw new Error('Select a v<package version> release tag, not a branch');
  if (match[5]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Numeric prerelease identifiers must not have leading zeros');
  }
  const aliases = match[5] ? [version] : [version, `${match[2]}.${match[3]}`, match[2], 'latest'];
  aliases.push(`sha-${sha}`);
  return { ref, sha, version, aliases };
}

export function assertImageReleaseTag(candidate, cwd = process.cwd()) {
  const output = execFileSync('git', ['ls-remote', '--exit-code', 'origin', candidate.ref, `${candidate.ref}^{}`], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Annotated tags name a tag object; qualification and every image build use
  // its peeled commit, just as actions/checkout does for the event SHA.
  const byRef = new Map(output.trim().split('\n').map(line => {
    const [sha, ref] = line.split(/\s+/);
    return [ref, sha];
  }));
  const current = byRef.get(`${candidate.ref}^{}`) ?? byRef.get(candidate.ref);
  if (current !== candidate.sha) throw new Error('The release tag moved after this candidate was selected');
}

export function imagePromotionPlan(candidate, { app, slimApp, base, slimBase }) {
  const images = [['varin', app, true], ['varin-slim', slimApp, true],
    ['varin-runtime-base', base, false], ['varin-runtime-slim', slimBase, false]];
  return images.flatMap(([name, digest, required]) => {
    if (!digest && !required) return [];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`Missing or invalid verified digest for ${name}`);
    const repository = `ghcr.io/youzini-afk/${name}`;
    return [['buildx', 'imagetools', 'create', ...candidate.aliases.flatMap(alias => ['--tag', `${repository}:${alias}`]), `${repository}@${digest}`]];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!['accept', 'promote'].includes(command)) throw new Error('Usage: docker-release.mjs accept|promote');
  const candidate = acceptImageRelease({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA, version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version });
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (checkedOut !== candidate.sha) throw new Error('Checkout does not match the release candidate SHA');
  assertImageReleaseTag(candidate);
  if (command === 'accept') {
    console.log(`Accepted ${candidate.ref} at ${candidate.sha}`);
  } else {
    // Validate the complete plan before the first mutation. The workflow gates
    // this job on exact-source CI and both immutable-image startup smokes.
    const plan = imagePromotionPlan(candidate, { app: process.env.VARIN_APP_DIGEST, slimApp: process.env.VARIN_SLIM_APP_DIGEST,
      base: process.env.VARIN_BASE_DIGEST, slimBase: process.env.VARIN_SLIM_BASE_DIGEST });
    for (const args of plan) execFileSync('docker', args, { stdio: 'inherit' });
  }
}
