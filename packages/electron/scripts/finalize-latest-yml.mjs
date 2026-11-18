#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseUpdateManifest } from './verify-update-manifest.mjs';

const dir = process.env.LATEST_YML_DIR;
const repo = process.env.GH_REPO;
const version = process.env.VARIN_VERSION;

if (!dir) throw new Error('LATEST_YML_DIR is required');
if (!repo) throw new Error('GH_REPO is required');
if (!version) throw new Error('VARIN_VERSION is required');

const serialize = (data) => {
  const lines = [`version: ${data.version}`, 'files:'];
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
    if (file.blockMapSize) {
      lines.push(`    blockMapSize: ${file.blockMapSize}`);
    }
  }
  lines.push(`releaseDate: '${data.releaseDate}'`);
  return `${lines.join('\n')}\n`;
};

const read = async (subdir, filename, platform, arch) => {
  const artifactDirectory = path.join(dir, subdir);
  const filePath = path.join(artifactDirectory, filename);
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const manifest = parseUpdateManifest(content);
  if (manifest.version !== version) {
    throw new Error(`${subdir}/${filename} targets ${manifest.version || '(missing version)'}, expected ${version}`);
  }
  if (manifest.files.length === 0) {
    throw new Error(`${subdir}/${filename} does not contain a downloadable file`);
  }
  const stem = `Varin-${version}-${platform}-${arch}.`;
  const allowed = platform === 'win' ? [stem + 'exe'] : [stem + 'zip', stem + 'dmg'];
  const names = manifest.files.map(entry => entry.url);
  if (!names.includes(allowed[0]) || names.length !== new Set(names).size || names.some(name => !allowed.includes(name))
    || manifest.packages || (manifest.path !== undefined && !names.includes(manifest.path))) {
    throw new Error(`${subdir}/${filename} references an artifact outside its desktop role or CPU`);
  }
  for (const entry of manifest.files) {
    const artifactName = entry.url;
    const artifactPath = path.join(artifactDirectory, artifactName);
    const bytes = await fs.readFile(artifactPath).catch((error) => {
      throw new Error(`${subdir}/${filename} references missing ${artifactName}: ${error.message}`);
    });
    if (bytes.length !== entry.size) {
      throw new Error(`${artifactName} size mismatch: manifest ${entry.size}, artifact ${bytes.length}`);
    }
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    if (sha512 !== entry.sha512) throw new Error(`${artifactName} sha512 mismatch`);
  }
  return manifest;
};

const output = {};

const winX64 = await read('latest-yml-x86_64-pc-windows-msvc', 'latest.yml', 'win', 'x64');
const winArm64 = await read('latest-yml-aarch64-pc-windows-msvc', 'latest.yml', 'win', 'arm64');
if (!winX64 || !winArm64) {
  throw new Error('Both x64 and arm64 Windows update manifests are required');
}
output['latest.yml'] = serialize(winX64);
output['latest-arm64.yml'] = serialize(winArm64);

const macX64 = await read('latest-yml-x86_64-apple-darwin', 'latest-mac.yml', 'mac', 'x64');
const macArm64 = await read('latest-yml-aarch64-apple-darwin', 'latest-mac.yml', 'mac', 'arm64');
if (macX64 || macArm64) {
  const base = macArm64 || macX64;
  output['latest-mac.yml'] = serialize({
    version: base.version,
    files: [...(macArm64?.files || []), ...(macX64?.files || [])],
    releaseDate: base.releaseDate,
  });
}

const tag = `v${version}`;
const tmp = process.env.RUNNER_TEMP || '/tmp';
for (const [filename, content] of Object.entries(output)) {
  const outputPath = path.join(tmp, filename);
  await fs.writeFile(outputPath, content);
  console.log(`prepared ${outputPath} for upload to ${repo} release ${tag}`);
}

console.log('finalized latest yml files');
