#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NPM_PUBLIC_PACKAGES,
  assertPackedPackage,
  existingArtifactDecision,
  prepareNpmPublicVersion,
  registryPackageVersion,
  verifyNpmPublicRelease,
} from './npm-public-release-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_MANIFEST = 'release.json';

const invocation = (command, args) => {
  if (command === 'node') return { args, command: process.execPath };
  if (command === 'npm' && process.platform === 'win32') {
    const npmCli = process.env.npm_execpath?.endsWith('npm-cli.js')
      ? process.env.npm_execpath
      : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { args: [npmCli, ...args], command: process.execPath };
  }
  return { args, command };
};

const run = (command, args, options = {}) => {
  const resolved = invocation(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (options.capture && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture && result.stdout) process.stdout.write(result.stdout);
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
  return result.stdout ?? '';
};

const gitCommit = () => run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();

const ensureEmptyDirectory = async (directory) => {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) throw new Error(`Release output directory is not empty: ${directory}`);
};

const packageRelease = async (tag, outputArgument) => {
  const release = await verifyNpmPublicRelease(ROOT, tag, { requireBuild: true });
  const output = path.resolve(ROOT, outputArgument);
  await ensureEmptyDirectory(output);
  const artifacts = [];
  for (const entry of release.packages) {
    const stdout = run('npm', ['pack', path.join(ROOT, entry.directory), '--pack-destination', output, '--json'], { capture: true });
    const [packed] = JSON.parse(stdout);
    assertPackedPackage(entry, packed);
    artifacts.push({
      directory: entry.directory,
      integrity: packed.integrity,
      name: entry.name,
      shasum: packed.shasum,
      tarball: packed.filename,
      version: release.version,
    });
  }

  const smokeRoot = await mkdtemp(path.join(os.tmpdir(), 'varin-npm-smoke-'));
  try {
    run('npm', ['init', '--yes'], { cwd: smokeRoot });
    run('npm', [
      'install', '--no-audit', '--no-fund', 'react@19', 'react-dom@19',
      ...artifacts.map(({ tarball }) => path.join(output, tarball)),
    ], { cwd: smokeRoot });
    const imports = [
      '@varin/extension-contract',
      '@varin/extension-surface',
      '@varin/extension-sdk',
      '@varin/extension-sdk/testing',
      '@varin/extension-react',
      '@varin/extension-cli',
    ];
    run('node', ['--input-type=module', '--eval', `for (const id of ${JSON.stringify(imports)}) await import(id);`], { cwd: smokeRoot });
    const sample = path.join(smokeRoot, 'sample-extension');
    const cli = path.join(smokeRoot, 'node_modules', '@varin', 'extension-cli', 'dist', 'cli.js');
    const cliRun = (args) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: smokeRoot, env: process.env, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`varin-extension ${args.join(' ')} exited with code ${result.status}`);
    };
    cliRun(['init', sample, '--id', 'dev.varin.release-smoke', '--name', 'Release Smoke']);
    cliRun(['build', sample]);
    cliRun(['check', sample]);
    cliRun(['test', sample]);

    // Also smoke a shell template project to verify the shell composition
    // contract (mountReplacement, mountSlot, disposer) is exercised.
    const shellSample = path.join(smokeRoot, 'shell-extension');
    cliRun(['init', shellSample, '--id', 'dev.varin.shell-smoke', '--name', 'Shell Smoke', '--template', 'shell']);
    cliRun(['build', shellSample]);
    cliRun(['check', shellSample]);
    cliRun(['test', shellSample]);
    const generated = JSON.parse(await readFile(path.join(sample, 'package.json'), 'utf8'));
    for (const dependency of ['@varin/extension-contract', '@varin/extension-sdk']) {
      if (generated.dependencies?.[dependency] !== release.version) {
        throw new Error(`Generated project uses ${dependency}@${generated.dependencies?.[dependency]}, expected ${release.version}`);
      }
    }
    if (generated.devDependencies?.['@varin/extension-cli'] !== release.version) {
      throw new Error(`Generated project uses the wrong @varin/extension-cli version`);
    }
  } finally {
    await rm(smokeRoot, { force: true, recursive: true });
  }

  const manifest = {
    artifacts,
    repository: 'Astrmira/Varin',
    schemaVersion: 1,
    sourceCommit: gitCommit(),
    tag,
    version: release.version,
  };
  await writeFile(path.join(output, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${artifacts.length} npm artifacts in ${output}`);
};

const publishRelease = async (tag, outputArgument) => {
  const release = await verifyNpmPublicRelease(ROOT, tag, { requireBuild: true });
  const output = path.resolve(ROOT, outputArgument);
  const manifest = JSON.parse(await readFile(path.join(output, RELEASE_MANIFEST), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.tag !== tag || manifest.version !== release.version) {
    throw new Error('Packaged npm release manifest does not match the requested tag');
  }
  if (manifest.sourceCommit !== gitCommit()) {
    throw new Error(`Packaged npm release came from ${manifest.sourceCommit}, current commit is ${gitCommit()}`);
  }
  const artifactByName = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact]));
  for (const definition of NPM_PUBLIC_PACKAGES) {
    const artifact = artifactByName.get(definition.name);
    if (!artifact || artifact.version !== release.version) {
      throw new Error(`Packaged npm release is missing ${definition.name}@${release.version}`);
    }
    await readFile(path.join(output, artifact.tarball));
    const metadata = await registryPackageVersion(artifact.name, artifact.version);
    const decision = existingArtifactDecision(metadata, artifact);
    if (decision === 'skip') {
      console.log(`Already published with matching integrity: ${artifact.name}@${artifact.version}`);
      continue;
    }
    run('npm', ['publish', path.join(output, artifact.tarball), '--access', 'public']);
  }
};

const prepareVersion = async (version) => {
  const tracked = [
    ...NPM_PUBLIC_PACKAGES.map(({ directory }) => path.join(ROOT, directory, 'package.json')),
    path.join(ROOT, 'packages', 'extension-cli', 'src', 'templates.ts'),
    path.join(ROOT, 'bun.lock'),
  ];
  const originals = new Map(await Promise.all(tracked.map(async (filePath) => [filePath, await readFile(filePath)])));
  try {
    await prepareNpmPublicVersion(ROOT, version);
    run('bun', ['install', '--lockfile-only']);
    await verifyNpmPublicRelease(ROOT, `npm-v${version}`);
  } catch (error) {
    await Promise.all([...originals].map(([filePath, contents]) => writeFile(filePath, contents)));
    throw error;
  }
  console.log(`Prepared public npm package version ${version}`);
};

const usage = () => {
  console.error('Usage:');
  console.error('  node scripts/npm-public-release.mjs prepare <version>');
  console.error('  node scripts/npm-public-release.mjs verify <npm-vX.Y.Z>');
  console.error('  node scripts/npm-public-release.mjs package <npm-vX.Y.Z> <output-directory>');
  console.error('  node scripts/npm-public-release.mjs publish <npm-vX.Y.Z> <output-directory>');
};

const [command, first, second] = process.argv.slice(2);
try {
  switch (command) {
    case 'prepare':
      if (!first || second) throw new Error('prepare requires exactly one version');
      await prepareVersion(first);
      break;
    case 'verify':
      if (!first || second) throw new Error('verify requires exactly one npm release tag');
      await verifyNpmPublicRelease(ROOT, first);
      console.log(`Verified public npm package set for ${first}`);
      break;
    case 'package':
      if (!first || !second) throw new Error('package requires a tag and output directory');
      await packageRelease(first, second);
      break;
    case 'publish':
      if (!first || !second) throw new Error('publish requires a tag and output directory');
      await publishRelease(first, second);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
