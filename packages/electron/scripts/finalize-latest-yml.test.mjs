import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./finalize-latest-yml.mjs', import.meta.url));

const artifact = (platform, architecture) => `Varin-1.2.3-${platform}-${architecture}.${platform === 'mac' ? 'zip' : 'exe'}`;
const artifactBytes = (platform, architecture) => Buffer.from(`${platform}:${architecture}:artifact`);
const manifest = (platform, architecture) => {
  const name = artifact(platform, architecture);
  const bytes = artifactBytes(platform, architecture);
  return `version: 1.2.3
files:
  - url: ${name}
    sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}
    size: ${bytes.length}
releaseDate: '2026-07-30T00:00:00.000Z'
`;
};

const writeManifestFixture = (artifacts, subdir, filename, platform, architecture) => {
  const directory = path.join(artifacts, subdir);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), manifest(platform, architecture));
  fs.writeFileSync(path.join(directory, artifact(platform, architecture)), artifactBytes(platform, architecture));
};

const createFixture = ({ includeArm64 = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-latest-yml-'));
  const artifacts = path.join(root, 'artifacts');
  const output = path.join(root, 'output');
  writeManifestFixture(
    artifacts,
    'latest-yml-x86_64-pc-windows-msvc',
    'latest.yml',
    'win',
    'x64',
  );
  if (includeArm64) {
    writeManifestFixture(
      artifacts,
      'latest-yml-aarch64-pc-windows-msvc',
      'latest.yml',
      'win',
      'arm64',
    );
  }
  fs.mkdirSync(output);
  return { root, artifacts, output };
};

const environment = ({ artifacts, output }) => ({
  ...process.env,
  LATEST_YML_DIR: artifacts,
  RUNNER_TEMP: output,
  GH_REPO: 'Astrmira/Varin',
  VARIN_VERSION: '1.2.3',
});

test('writes separate x64 and ARM64 Windows update channels', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const x64 = fs.readFileSync(path.join(fixture.output, 'latest.yml'), 'utf8');
  const arm64 = fs.readFileSync(path.join(fixture.output, 'latest-arm64.yml'), 'utf8');
  assert.match(x64, /win-x64\.exe/);
  assert.doesNotMatch(x64, /win-arm64\.exe/);
  assert.match(arm64, /win-arm64\.exe/);
  assert.doesNotMatch(arm64, /win-x64\.exe/);
});

test('fails instead of publishing an incomplete Windows channel set', (context) => {
  const fixture = createFixture({ includeArm64: false });
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Both x64 and arm64 Windows update manifests are required/);
});

test('merges verified Intel and Apple Silicon macOS update files', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  writeManifestFixture(
    fixture.artifacts,
    'latest-yml-x86_64-apple-darwin',
    'latest-mac.yml',
    'mac',
    'x64',
  );
  writeManifestFixture(
    fixture.artifacts,
    'latest-yml-aarch64-apple-darwin',
    'latest-mac.yml',
    'mac',
    'arm64',
  );

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const mac = fs.readFileSync(path.join(fixture.output, 'latest-mac.yml'), 'utf8');
  assert.match(mac, /mac-x64\.zip/);
  assert.match(mac, /mac-arm64\.zip/);
});

test('keeps an Apple Silicon macOS channel when Intel packaging is omitted', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  writeManifestFixture(
    fixture.artifacts,
    'latest-yml-aarch64-apple-darwin',
    'latest-mac.yml',
    'mac',
    'arm64',
  );

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const mac = fs.readFileSync(path.join(fixture.output, 'latest-mac.yml'), 'utf8');
  assert.match(mac, /mac-arm64\.zip/);
  assert.doesNotMatch(mac, /mac-x64\.zip/);
});

test('rejects a manifest whose artifact checksum no longer matches', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.appendFileSync(
    path.join(
      fixture.artifacts,
      'latest-yml-x86_64-pc-windows-msvc',
      artifact('win', 'x64'),
    ),
    'tampered',
  );

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /size mismatch/);
});
