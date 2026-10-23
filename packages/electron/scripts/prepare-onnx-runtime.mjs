import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { detectKernelBinaryIdentity } = require('../../../scripts/kernel-binary-identity.cjs');
const VERSION = '1.30.0';
const COMMIT = 'f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7';
const RECIPE = 1;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

// Upstream still builds the x86_64 CPU and Node-API targets, but no longer ships
// their macOS binaries in npm. Compile both from the same revision as our JS API.
export function prepareOnnxRuntime(runtimeManifest = new URL('../../web/package.json', import.meta.url)) {
  if (process.platform !== 'darwin' || process.arch !== 'x64') return;
  const webRequire = createRequire(runtimeManifest);
  const transformersRequire = createRequire(webRequire.resolve('@huggingface/transformers'));
  const packageRoot = path.dirname(path.dirname(transformersRequire.resolve('onnxruntime-node')));
  const installedVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  if (installedVersion !== VERSION) {
    throw new Error(`ONNX source recipe is for ${VERSION}, but the installed package is ${installedVersion}.`);
  }
  const cache = path.join(os.homedir(), '.cache', 'varin-native', `onnxruntime-${COMMIT}-darwin-x64-r${RECIPE}`);
  const payload = path.join(cache, 'payload');
  const receiptPath = path.join(cache, 'receipt.json');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = receipt?.files;
  const cached = receipt?.commit === COMMIT && receipt?.recipe === RECIPE
    && receipt?.version === VERSION && files?.['onnxruntime_binding.node']
    && Object.entries(files).every(([name, hash]) => path.basename(name) === name
      && fs.existsSync(path.join(payload, name)) && sha256(path.join(payload, name)) === hash);

  if (!cached) {
    fs.mkdirSync(cache, { recursive: true });
    const source = path.join(cache, 'source');
    if (!fs.existsSync(path.join(source, '.git'))) {
      fs.mkdirSync(source, { recursive: true });
      run('git', ['init', source], cache);
      run('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/microsoft/onnxruntime.git', COMMIT], cache);
      run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD'], cache);
    }
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    if (revision !== COMMIT) throw new Error(`Unexpected ONNX source revision: ${revision}`);
    run('git', ['diff', '--quiet', 'HEAD'], source);
    run('python3', [
      'tools/ci_build/build.py', '--build_dir', path.join(cache, 'build'),
      '--config', 'Release', '--update', '--build', '--parallel', String(os.availableParallelism()),
      '--build_shared_lib', '--build_nodejs', '--osx_arch', 'x86_64',
      '--cmake_generator', 'Ninja', '--skip_tests', '--compile_no_warning_as_error',
      '--cmake_extra_defines', 'onnxruntime_BUILD_UNIT_TESTS=OFF',
    ], source);
    const output = path.join(source, 'js', 'node', 'bin', 'napi-v6', 'darwin', 'x64');
    const identity = detectKernelBinaryIdentity(fs.readFileSync(path.join(output, 'onnxruntime_binding.node')));
    if (identity.platform !== 'darwin' || identity.arch !== 'x64') {
      throw new Error(`ONNX build produced ${identity.platform}/${identity.arch}, expected darwin/x64.`);
    }
    // Preserve all companion dylibs beside the binding; dereference build-tree
    // symlinks so the installed payload cannot point back into the build cache.
    fs.rmSync(payload, { recursive: true, force: true });
    fs.cpSync(output, payload, { recursive: true, dereference: true });
    receipt = { version: VERSION, commit: COMMIT, recipe: RECIPE, files: {} };
    for (const name of fs.readdirSync(payload)) {
      receipt.files[name] = sha256(path.join(payload, name));
    }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  }

  const destination = path.join(packageRoot, 'bin', 'napi-v6', 'darwin', 'x64');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of Object.keys(receipt.files)) fs.copyFileSync(path.join(payload, name), path.join(destination, name));
  // A matching Mach-O header alone cannot prove its dylibs can actually load.
  execFileSync(process.execPath, ['-e', 'require(process.argv[1])', packageRoot], { stdio: 'inherit' });
  console.log(`[electron] prepared ONNX ${VERSION} darwin/x64 from ${COMMIT}${cached ? ' (verified cache)' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareOnnxRuntime();
