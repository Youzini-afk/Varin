#!/usr/bin/env node
/** Build the separately installed, target-native local embedding component. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { prepareOnnxRuntime } from '../packages/electron/scripts/prepare-onnx-runtime.mjs';
import { BuildCache } from './build-cache.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const webRoot = path.join(repository, 'packages/web');
const electronRoot = path.join(repository, 'packages/electron');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const electronRequire = createRequire(path.join(electronRoot, 'package.json'));
const tar = webRequire('tar');
const version = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version;
const architecture = process.env.VARIN_TARGET_ARCH || process.arch;
if (architecture !== process.arch) throw new Error('Build local inference components on a matching native runner');
const outputArgument = process.argv.indexOf('--output');
const modelSourceArgument = process.argv.indexOf('--model-source');
const customModelSource = modelSourceArgument >= 0 ? path.resolve(process.argv[modelSourceArgument + 1]) : null;
const outputDirectory = path.resolve(outputArgument >= 0 ? process.argv[outputArgument + 1] : path.join(electronRoot, 'dist'));
await fsp.mkdir(outputDirectory, { recursive: true });
const artifact = path.join(outputDirectory, `Varin-local-semantic-${version}-${process.platform}-${architecture}.tar.gz`);
const buildCache = new BuildCache(repository);
const componentSource = await buildCache.inputs(['scripts/build-local-semantic-component.mjs', 'scripts/local-embedding-runtime',
  'scripts/build-cache.mjs', 'packages/electron/scripts/prepare-onnx-runtime.mjs',
  'packages/web/scripts/copy-semantic-model.mjs', 'scripts/local-embedding-worker.mjs',
  'packages/web/application-host/lib/knowledge/semantic/local-component-manifest.ts',
  'packages/web/application-host/lib/knowledge/semantic/runtime/bekko-embedding-v1-a8m/recipe.json',
  'packages/web/application-host/lib/knowledge/semantic/runtime/bekko-embedding-v1-a8m/source.json']);
const componentVersion = createHash('sha256').update(JSON.stringify({ componentSource, platform: process.platform, architecture,
  nodeMajor: process.versions.node.split('.')[0], napi: process.versions.napi,
  customModel: customModelSource ? await buildCache.outputs([customModelSource]) : null,
})).digest('hex');
const componentCache = path.join(os.homedir(), '.cache/varin-components/local-semantic', `${process.platform}-${architecture}`);
const cachedArchive = path.join(componentCache, 'component.tar.gz');
let cached;
try { cached = JSON.parse(await fsp.readFile(path.join(componentCache, 'receipt.json'), 'utf8')); } catch { /* first component build */ }
if (cached?.componentVersion === componentVersion && fs.existsSync(cachedArchive)
  && createHash('sha256').update(await fsp.readFile(cachedArchive)).digest('hex') === cached.sha256) {
  await fsp.copyFile(cachedArchive, artifact);
  await fsp.writeFile(`${artifact}.sha256`, `${cached.sha256}  ${path.basename(artifact)}\n`);
  console.log(`[local-semantic] reused verified component ${componentVersion.slice(0, 16)}: ${artifact}`);
  process.exit(0);
}
const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-local-semantic-build-'));
const modules = path.join(staging, 'runtime/node_modules');
const copied = new Map();
const runtimeManifest = path.join(staging, 'dependencies/package.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function resolvePackage(name, importerManifest) {
  const resolver = createRequire(importerManifest);
  for (const base of resolver.resolve.paths(name) || []) {
    const candidate = path.join(base, name, 'package.json');
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
  }
  throw new Error(`Missing ${name}, required by ${importerManifest}`);
}

function supportsTarget(manifest) {
  const matches = (values, actual) => !Array.isArray(values)
    || (!values.includes(`!${actual}`) && (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
  return matches(manifest.os, process.platform) && matches(manifest.cpu, architecture)
    && matches(manifest.libc, 'glibc');
}

async function copyPackage(name, importerManifest, parentModules = modules) {
  const source = resolvePackage(name, importerManifest);
  const manifest = readJson(path.join(source, 'package.json'));
  if (!supportsTarget(manifest)) return;
  let destination = path.join(modules, name);
  if (copied.has(destination)) {
    if (copied.get(destination) === manifest.version) return;
    destination = path.join(parentModules, name);
  }
  if (copied.has(destination)) {
    if (copied.get(destination) !== manifest.version) throw new Error(`Conflicting dependency ${name}`);
    return;
  }
  copied.set(destination, manifest.version);
  await fsp.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const relative = path.relative(source, file).replaceAll('\\', '/');
      const parts = relative.split('/');
      if (parts.includes('node_modules') || ['test', 'tests', 'docs', 'examples'].includes(parts[0])) return false;
      if (/\.(?:map|d\.ts|tsbuildinfo)$/.test(relative)) return false;
      if (name === '@huggingface/transformers') {
        return relative === '' || ['package.json', 'LICENSE', 'dist', 'dist/transformers.node.mjs'].includes(relative);
      }
      if (name === 'onnxruntime-node' && relative.startsWith('bin/napi-v6/')) {
        return parts[2] === process.platform && (parts.length < 4 || parts[3] === architecture);
      }
      return true;
    },
  });
  // transformers.node.mjs already inlines its browser backend, tokenizer and
  // template code. Only its external Node imports belong in this component.
  const dependencies = name === '@huggingface/transformers'
    ? { 'onnxruntime-node': manifest.dependencies['onnxruntime-node'], 'sharp': manifest.dependencies.sharp, '@huggingface/tokenizers': manifest.dependencies['@huggingface/tokenizers'] }
    : manifest.dependencies || {};
  for (const dependency of Object.keys(dependencies)) {
    await copyPackage(dependency, path.join(source, 'package.json'), path.join(destination, 'node_modules'));
  }
  for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
    let optional;
    try { optional = readJson(path.join(resolvePackage(dependency, path.join(source, 'package.json')), 'package.json')); }
    catch { continue; }
    if (supportsTarget(optional)) await copyPackage(dependency, path.join(source, 'package.json'), path.join(destination, 'node_modules'));
  }
}

try {
  if (!customModelSource) {
    execFileSync(process.execPath, [path.join(webRoot, 'scripts/copy-semantic-model.mjs')], { stdio: 'inherit', windowsHide: true });
  }
  // The optional runtime has its own pinned dependency graph. Ordinary app
  // installation and packaging never install Transformers or ONNX for it.
  await fsp.mkdir(path.dirname(runtimeManifest), { recursive: true });
  for (const file of ['package.json', 'bun.lock']) await fsp.copyFile(path.join(repository, 'scripts/local-embedding-runtime', file), path.join(path.dirname(runtimeManifest), file));
  execFileSync(process.platform === 'win32' ? 'bun.exe' : 'bun', ['install', '--frozen-lockfile'], { cwd: path.dirname(runtimeManifest), stdio: 'inherit', windowsHide: true });
  prepareOnnxRuntime(runtimeManifest);
  await copyPackage('@huggingface/transformers', runtimeManifest);
  await fsp.rm(path.dirname(runtimeManifest), { recursive: true, force: true });
  await fsp.copyFile(path.join(repository, 'scripts/local-embedding-worker.mjs'), path.join(staging, 'runtime/local-embedding-worker.mjs'));
  const sourceModel = customModelSource ?? path.join(webRoot, 'application-host/lib/knowledge/semantic/runtime/bekko-embedding-v1-a8m');
  const recipe = readJson(path.join(sourceModel, 'recipe.json'));
  const modelFiles = [...new Set(['recipe.json', recipe.tokenizerFile, 'tokenizer_config.json', 'config.json', recipe.onnxFile,
    ...['special_tokens_map.json', 'LICENSE', 'NOTICE.txt', 'README.md'].filter(file => fs.existsSync(path.join(sourceModel, file)))])];
  for (const file of modelFiles) {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '..')) {
      throw new Error('Model recipe files must remain inside the model source and component directory');
    }
    const destination = path.join(staging, 'model', file);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(path.join(sourceModel, file), destination);
  }
  if (!fs.existsSync(path.join(staging, 'model/NOTICE.txt')) && !fs.existsSync(path.join(staging, 'model/LICENSE'))) {
    throw new Error('Custom model source must include its upstream license or NOTICE, separate from runtime licenses');
  }
  const transformersEntry = 'runtime/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
  const check = `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const probe = await mkdtemp(join(tmpdir(), 'varin-local-embedding-probe-'));
    let worker;
    try {
    await cp(${JSON.stringify(staging)}, probe, { recursive: true });
    const { Tokenizer } = await import(pathToFileURL(join(probe, 'runtime/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs')).href);
    const tokenizer = new Tokenizer(JSON.parse(await readFile(join(probe, 'model', ${JSON.stringify(recipe.tokenizerFile)}), 'utf8')),
      JSON.parse(await readFile(join(probe, 'model/tokenizer_config.json'), 'utf8')));
    const text = 'Varin optional local inference';
    const tokens = tokenizer.encode(text).ids.length;
    assert.ok(tokens > 0);
    worker = new Worker(pathToFileURL(join(probe, 'runtime/local-embedding-worker.mjs')), {
      execArgv: [], workerData: { protocol: 1,
        entry: join(probe, ${JSON.stringify(transformersEntry)}), modelRoot: join(probe, 'model'), modelFileName: ${JSON.stringify(path.basename(recipe.onnxFile, '.onnx'))},
        dim: ${JSON.stringify(recipe.dim)}, pooling: ${JSON.stringify(recipe.pooling)}, normalize: ${JSON.stringify(recipe.normalize)}, threads: 1 },
    });
      await new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('exit', code => reject(new Error('Component worker exited: ' + code)));
        worker.on('message', message => {
          try {
            if (message.type === 'ready') {
              assert.equal(message.protocol, 1);
              worker.postMessage({ type: 'enqueue', id: 1, texts: [text], priority: 'foreground' });
            } else if (message.type === 'settled') {
              assert.equal(message.requestStarted, true); assert.equal(message.completed, true);
              assert.equal(message.error, undefined);
              assert.equal(message.vectors[0].length, ${JSON.stringify(recipe.dim)});
              assert.ok(message.vectors[0].every(Number.isFinite));
              assert.ok(message.vectors[0].some(value => value !== 0));
              assert.equal(message.usage.inputTokens, tokens);
              resolve();
            }
          } catch (error) { reject(error); }
        });
      });
    } finally { await worker?.terminate(); await rm(probe, { recursive: true, force: true }); }
    console.log('[local-semantic] staged worker produced a real ${recipe.dim}-dimensional vector');
    console.log('[local-semantic] tokenizer matched Worker usage; native files reclaimed without exiting Host');
  `;
  execFileSync(electronRequire('electron'), ['--input-type=module', '-e', check], {
    cwd: staging, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, stdio: 'inherit', windowsHide: true,
  });
  const files = {};
  async function recordFiles(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await recordFiles(file);
      else {
        const bytes = await fsp.readFile(file);
        files[path.relative(staging, file).replaceAll('\\', '/')] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      }
    }
  }
  await recordFiles(staging);
  await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({
    schemaVersion: 4, workerProtocol: 1, id: 'local-semantic', version: `4.1-${componentVersion.slice(0, 16)}`, platform: process.platform, arch: architecture,
    modelPath: 'model', transformersEntry, workerEntry: 'runtime/local-embedding-worker.mjs', files,
  }, null, 2) + '\n');
  await tar.c({ cwd: staging, file: `${artifact}.tmp`, gzip: true, portable: true }, ['manifest.json', 'model', 'runtime']);
  await fsp.rename(`${artifact}.tmp`, artifact);
  const bytes = await fsp.readFile(artifact);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await fsp.writeFile(`${artifact}.sha256`, `${sha256}  ${path.basename(artifact)}\n`);
  await fsp.mkdir(componentCache, { recursive: true });
  await fsp.copyFile(artifact, `${cachedArchive}.tmp-${process.pid}`);
  await fsp.rename(`${cachedArchive}.tmp-${process.pid}`, cachedArchive);
  await fsp.writeFile(path.join(componentCache, 'receipt.json'), JSON.stringify({ schema: 1, componentVersion, sha256 }) + '\n');
  console.log(`[local-semantic] ${artifact} (${(bytes.length / 1048576).toFixed(1)} MiB; ${Object.keys(files).length} files)`);
} finally {
  await fsp.rm(staging, { recursive: true, force: true });
}
