import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { desktopReleaseProduct } from './desktop-release-product.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true });
export function releaseTargets(includeIntel = false) {
  const targets = [
    ['Windows x64', 'windows', 'win', 'win32', 'x64', 'windows-latest', 'x86_64-pc-windows-msvc'],
    ['Windows ARM64', 'windows', 'win', 'win32', 'arm64', 'windows-11-arm', 'aarch64-pc-windows-msvc'],
    ['Linux x64', 'linux', 'linux', 'linux', 'x64', 'ubuntu-22.04', 'x86_64-unknown-linux-gnu'],
    ['Linux ARM64', 'linux', 'linux', 'linux', 'arm64', 'ubuntu-24.04-arm', 'aarch64-unknown-linux-gnu'],
    ['macOS Apple Silicon', 'macos', 'mac', 'darwin', 'arm64', 'macos-15', 'aarch64-apple-darwin'],
    ...(includeIntel ? [['macOS Intel', 'macos', 'mac', 'darwin', 'x64', 'macos-15-intel', 'x86_64-apple-darwin']] : []),
  ];
  return targets.map(([label, platform, target, nodePlatform, architecture, runner, triple]) => ({
    label, platform, target, nodePlatform, architecture, runner, artifact: `latest-yml-${triple}`,
  }));
}

// Older tags did not ship a light packaging contract. Keep replaying their
// full-only release rather than applying new product code to accepted source.
function sourceRoles(value = ['full']) {
  if (JSON.stringify(value) !== '["full"]' && JSON.stringify(value) !== '["full","light"]') throw new Error('Unsupported desktop release roles');
  return value;
}

export function releaseMatrices(candidate) {
  const native = releaseTargets(candidate.includeIntel);
  const desktop = native.flatMap(target => sourceRoles(candidate.desktopRoles).map(role => ({
    ...target, role, label: target.label + ' · ' + role,
    artifact: target.artifact + (role === 'full' ? '' : '-light'),
  })));
  const needsGuest = target => target.role === 'full' && target.platform === 'linux' && target.architecture === 'x64';
  return { matrix: { include: desktop.filter(target => !needsGuest(target)) },
    linux_matrix: { include: desktop.filter(needsGuest) }, component_matrix: { include: native } };
}

export async function resolveCandidate({ releaseRef, toolingSha, runId, androidVersionCode, includeIntel, existing, resolveSource }) {
  if (existing) {
    if (existing.schema !== 1 || existing.releaseRef !== releaseRef || existing.toolingSha !== toolingSha
      || existing.runId !== runId || existing.androidVersionCode !== androidVersionCode || existing.includeIntel !== includeIntel
      || !/^[a-f0-9]{40}$/u.test(existing.sourceSha) || existing.releaseRef !== `v${existing.version}`) {
      throw new Error('The accepted release candidate does not match this workflow run');
    }
    sourceRoles(existing.desktopRoles);
    return existing;
  }
  const source = await resolveSource(releaseRef);
  if (!/^[a-f0-9]{40}$/u.test(source.sha) || releaseRef !== `v${source.version}`) throw new Error('Release tag and source package version must agree');
  return { schema: 1, desktopRoles: sourceRoles(source.desktopRoles), releaseRef, sourceSha: source.sha, version: source.version, toolingSha, runId, androidVersionCode, includeIntel };
}

export async function recordAssets(directory, { sourceSha, version, toolingSha, kind, platform, arch, role }) {
  const files = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (name === 'release-assets.json') continue;
    const bytes = await fs.readFile(path.join(directory, name));
    files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
  }
  if (!files.length) throw new Error('Cannot record an empty release product');
  const receipt = { schema: 1, sourceSha, version, toolingSha, kind, platform, arch, ...(kind === 'desktop' ? { role: role ?? 'full' } : {}), files };
  await fs.writeFile(path.join(directory, 'release-assets.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export async function verifyArtifacts(directory, candidate) {
  const required = new Set(releaseTargets(candidate.includeIntel).flatMap(target => [
    ...sourceRoles(candidate.desktopRoles).map(role => `desktop/${role}/${target.nodePlatform}/${target.architecture}`), `component/${target.nodePlatform}/${target.architecture}`,
  ]).concat('android/android/universal'));
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(directory, entry.name);
    const receipt = await json(path.join(root, 'release-assets.json'));
    if (receipt.schema !== 1 || receipt.sourceSha !== candidate.sourceSha || receipt.version !== candidate.version || receipt.toolingSha !== candidate.toolingSha) {
      throw new Error(`Release product source mismatch: ${entry.name}`);
    }
    const role = receipt.role ?? 'full';
    const kind = receipt.kind === 'desktop' ? 'desktop/' + role : receipt.kind;
    const target = `${kind}/${receipt.platform}/${receipt.arch}`;
    if (!required.delete(target)) throw new Error(`Unexpected or duplicated release product: ${target}`);
    const names = new Set(['release-assets.json']);
    for (const file of receipt.files) {
      if (!file.name || path.basename(file.name) !== file.name || names.has(file.name)) throw new Error('Invalid release product filename');
      names.add(file.name);
      const bytes = await fs.readFile(path.join(root, file.name));
      if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Release asset digest mismatch: ${file.name}`);
    }
    if (receipt.kind === 'desktop') {
      const product = desktopReleaseProduct({ role, platform: receipt.platform, arch: receipt.arch, version: candidate.version });
      const expected = [...product.required, ...(product.manifest ? [product.manifest] : [])];
      for (const name of expected) if (!names.has(name)) throw new Error(`Missing ${target} asset: ${name}`);
      const allowed = new Set(['release-assets.json', ...expected, ...product.optional]);
      for (const name of names) if (!allowed.has(name)) throw new Error(`Unexpected ${target} asset: ${name}`);
    }
    for (const name of await fs.readdir(root)) if (!names.has(name)) throw new Error(`Unrecorded release asset: ${name}`);
  }
  if (required.size) throw new Error(`Missing release products: ${[...required].join(', ')}`);
}

export async function finalizeAssets(directory, candidate) {
  const files = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (['release-source.json', 'SHA256SUMS'].includes(name)) continue;
    const bytes = await fs.readFile(path.join(directory, name));
    files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
  }
  if (candidate.version) {
    const names = new Set(files.map(file => file.name));
    for (const target of releaseTargets(candidate.includeIntel)) for (const role of sourceRoles(candidate.desktopRoles)) {
      const product = desktopReleaseProduct({ role, platform: target.nodePlatform, arch: target.architecture, version: candidate.version });
      for (const name of [...product.required, ...(product.finalManifest ? [product.finalManifest] : [])]) {
        if (!names.has(name)) throw new Error(`Missing final desktop asset: ${name}`);
      }
    }
  }
  const source = Buffer.from(JSON.stringify({ ...candidate, files }, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'release-source.json'), source);
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), [...files.map(file => `${file.sha256}  ${file.name}`), `${sha(source)}  release-source.json`].join('\n') + '\n');
}

export async function assertReleaseRef(candidate, resolveSha) {
  if (await resolveSha(candidate.releaseRef) !== candidate.sourceSha) throw new Error('The release tag moved after this candidate was accepted; verified artifacts are retained for the accepted source');
}

async function candidateCommand(directory) {
  const repo = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID;
  const artifacts = JSON.parse(gh('api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
  let existing;
  if (artifacts.some(item => item.name === 'varin-release-candidate' && !item.expired)) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-release-candidate-'));
    try {
      gh('run', 'download', runId, '--repo', repo, '--name', 'varin-release-candidate', '--dir', temporary);
      existing = await json(path.join(temporary, 'candidate.json'));
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const candidate = await resolveCandidate({ existing, runId, releaseRef: process.env.VARIN_RELEASE_REF,
    toolingSha: process.env.GITHUB_SHA, androidVersionCode: process.env.GITHUB_RUN_NUMBER,
    includeIntel: process.env.INCLUDE_MACOS_INTEL === 'true',
    async resolveSource(ref) {
      const { sha: sourceSha } = JSON.parse(gh('api', `repos/${repo}/commits/${encodeURIComponent(ref)}`));
      const versions = [];
      let desktopRoles;
      for (const file of ['package.json', 'packages/electron/package.json', 'packages/web/package.json']) {
        const data = JSON.parse(gh('api', `repos/${repo}/contents/${file}?ref=${sourceSha}`));
        const manifest = JSON.parse(Buffer.from(data.content, 'base64').toString());
        versions.push(manifest.version);
        if (file === 'packages/electron/package.json') desktopRoles = manifest.desktopReleaseRoles;
      }
      if (new Set(versions).size !== 1) throw new Error('Product, Electron and Web release versions differ');
      return { sha: sourceSha, version: versions[0], desktopRoles };
    },
  });
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  const matrices = releaseMatrices(candidate);
  await fs.appendFile(process.env.GITHUB_OUTPUT, [
    `sha=${candidate.sourceSha}`, `version=${candidate.version}`, `android_code=${candidate.androidVersionCode}`,
    ...Object.entries(matrices).map(([name, value]) => `${name}=${JSON.stringify(value)}`), '',
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1]; };
  const directory = command === 'assert-ref' ? null : path.resolve(option('--directory'));
  if (command === 'assert-ref') await assertReleaseRef(await json(option('--candidate')), async ref =>
    JSON.parse(gh('api', `repos/${process.env.GITHUB_REPOSITORY}/commits/${encodeURIComponent(ref)}`)).sha);
  else if (command === 'candidate') await candidateCommand(directory);
  else if (command === 'record') {
    const sourceSha = git('rev-parse', 'HEAD');
    if (sourceSha !== process.env.VARIN_RELEASE_SOURCE_SHA) throw new Error(`Release source mismatch: expected ${process.env.VARIN_RELEASE_SOURCE_SHA}, got ${sourceSha}`);
    const changes = git('status', '--porcelain', '--untracked-files=no');
    if (changes) throw new Error(`Tracked source files changed during the release build:\n${changes}`);
    await recordAssets(directory, { sourceSha, toolingSha: process.env.VARIN_RELEASE_TOOLING_SHA,
      version: JSON.parse(await fs.readFile('package.json', 'utf8')).version, kind: option('--kind'), role: process.env.VARIN_DESKTOP_ROLE, platform: option('--platform'), arch: option('--arch') });
  } else if (command === 'verify') await verifyArtifacts(directory, await json(option('--candidate')));
  else if (command === 'finalize') await finalizeAssets(directory, await json(option('--candidate')));
  else throw new Error('Usage: release-artifacts.mjs candidate|record|verify|finalize --directory path');
}
