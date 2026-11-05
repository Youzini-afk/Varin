#!/usr/bin/env node
/** Build once per source/toolchain/target, then publish a verified immutable helper. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import artifact from './helper-artifact.cjs';
const source = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(source, '../../..');
const { PROTOCOL_VERSION, EXECUTABLE, digest, inspectExecutable, readSignature, verifyHelper } = artifact;
export const windowsHelperInputs = ['kernel/crates/varin-computer-windows', 'kernel/Cargo.toml', 'kernel/Cargo.lock',
  'kernel/rust-toolchain.toml', 'packages/computer-driver/windows', 'packages/electron/resources/icons/icon.ico',
  'scripts/kernel-binary-identity.cjs', 'package.json'];

function sourceIdentity(root) {
  const entries = [];
  const visit = file => {
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!['target', 'node_modules', 'build'].includes(name) && !name.startsWith('.')) visit(path.join(file, name));
    } else if (!file.endsWith('.exe') && path.basename(file) !== 'manifest.json') entries.push([path.relative(root, file).replaceAll('\\', '/'), digest(fs.readFileSync(file))]);
  };
  for (const input of windowsHelperInputs) visit(path.join(root, input));
  return digest(JSON.stringify(entries));
}

function windowsEnvironment(architecture, run, environment) {
  if (environment.INCLUDE && environment.WindowsSdkDir && environment.VSCMD_ARG_TGT_ARCH === architecture) return environment;
  const installer = path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const installation = String(run(installer, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', env: environment })).trim();
  if (!installation) throw new Error('Visual Studio C++ build tools and the Windows SDK are required to build VarinComputer');
  const script = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  const output = String(run('cmd.exe', ['/d', '/s', '/c', `call "%VARIN_VSDEVCMD%" -arch=${architecture} -host_arch=${process.arch} >nul && set`],
    { encoding: 'utf8', windowsHide: true, env: { ...environment, VARIN_VSDEVCMD: script } }));
  const env = { ...environment };
  for (const line of output.split(/\r?\n/)) { const split = line.indexOf('='); if (split > 0) env[line.slice(0, split)] = line.slice(split + 1); }
  return env;
}

export function windowsHelperBuildIdentity({ architecture = process.env.VARIN_TARGET_ARCH || process.arch,
  root = repository, run = execFileSync, environment = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('The Windows Computer helper requires a Windows build host and SDK');
  const target = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[architecture];
  if (!target) throw new Error(`Unsupported Windows Computer helper architecture: ${architecture}`);
  const pinned = /^channel\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'kernel/rust-toolchain.toml'), 'utf8'))?.[1];
  if (!pinned) throw new Error('The Computer helper requires the pinned kernel Rust toolchain');
  const env = windowsEnvironment(architecture, run, { ...environment, RUSTUP_TOOLCHAIN: environment.RUSTUP_TOOLCHAIN || pinned });
  const options = { cwd: path.join(root, 'kernel'), encoding: 'utf8', windowsHide: true, env };
  const rustc = String(run('rustc', ['--version', '--verbose'], options)).trim();
  const cargo = String(run('cargo', ['--version'], options)).trim();
  const rc = String(run('where.exe', ['rc.exe'], options)).trim().split(/\r?\n/)[0];
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  // Cargo's encoded flags override RUSTFLAGS. Always append static CRT to the
  // effective encoded flags, including when a caller supplied their own flags.
  const flags = environment.CARGO_ENCODED_RUSTFLAGS
    ? environment.CARGO_ENCODED_RUSTFLAGS.split('\x1f') : (environment.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
  env.CARGO_ENCODED_RUSTFLAGS = [...flags, '-C', 'target-feature=+crt-static'].join('\x1f');
  delete env.RUSTFLAGS;
  const values = { source: sourceIdentity(root), target, architecture, version, rustc, cargo, resourceCompiler: digest(fs.readFileSync(rc)),
    sdk: env.WindowsSDKVersion || '', vcTools: env.VCToolsVersion || '', toolchain: env.RUSTUP_TOOLCHAIN,
    flags: env.CARGO_ENCODED_RUSTFLAGS, profiles: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('CARGO_PROFILE_')).sort()),
    requireSignature: environment.VARIN_COMPUTER_REQUIRE_SIGNATURE === '1',
    certificate: environment.VARIN_COMPUTER_SIGN_CERTIFICATE_SHA1 || '', timestamp: environment.VARIN_COMPUTER_SIGN_TIMESTAMP || '' };
  return { values, buildId: digest(JSON.stringify(values)), env };
}

function publish(candidate, destination) {
  const previous = path.join(path.dirname(destination), `.VarinComputer-previous-${randomUUID()}`);
  let moved = false;
  try {
    if (fs.existsSync(destination)) { fs.renameSync(destination, previous); moved = true; }
    try { fs.renameSync(candidate, destination); }
    catch (error) {
      if (moved) { try { fs.renameSync(previous, destination); } catch (restore) { throw new AggregateError([error, restore], `Previous Computer helper retained at ${previous}`); } }
      throw error;
    }
    // Publication already committed. A running old executable may keep its
    // generation locked on Windows; retaining it is not a failed publication.
    if (moved) try { fs.rmSync(previous, { recursive: true, force: true }); } catch { /* old generation remains intact */ }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}

export function buildWindowsComputerHelper({ destination = path.join(source, 'build'), root = repository,
  architecture = process.env.VARIN_TARGET_ARCH || process.arch, platform = process.platform, environment = process.env,
  run = execFileSync, identity = windowsHelperBuildIdentity({ architecture, root, run, environment, platform }) } = {}) {
  const { values, buildId, env } = identity;
  if (values.architecture !== architecture || !/^[a-f0-9]{64}$/.test(buildId)) throw new Error('Computer helper build identity does not match the requested target');
  const cacheRoot = path.join(root, 'artifacts/build/computer-windows');
  const cached = path.join(cacheRoot, buildId);
  const requireSignature = environment.VARIN_COMPUTER_REQUIRE_SIGNATURE === '1';
  let valid = false;
  try { verifyHelper(cached, { architecture, version: values.version, requireSignature, verifySignature: true, run }); valid = true; }
  catch { /* Missing or damaged cache entries are never reused; build a new candidate. */ }
  if (!valid) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const candidate = fs.mkdtempSync(path.join(cacheRoot, '.candidate-'));
    try {
      const targetDir = path.join(root, 'kernel/target/computer-windows');
      const buildEnv = { ...env, VARIN_COMPUTER_VERSION: values.version, VARIN_COMPUTER_BUILD_ID: buildId };
      run('cargo', ['build', '--manifest-path', path.join(root, 'kernel/Cargo.toml'), '-p', 'varin-computer-windows', '--bin', 'VarinComputer',
        '--release', '--locked', '--target', values.target, '--target-dir', targetDir], { cwd: path.join(root, 'kernel'), env: buildEnv, stdio: 'inherit', windowsHide: true });
      const executable = path.join(candidate, EXECUTABLE);
      fs.copyFileSync(path.join(targetDir, values.target, 'release', EXECUTABLE), executable);
      inspectExecutable(fs.readFileSync(executable), architecture);
      if (values.certificate) {
        if (!/^[a-f\d]{40}$/i.test(values.certificate)) throw new Error('Computer signing certificate must be a SHA-1 thumbprint');
        if (!values.timestamp) throw new Error('A timestamp URL is required for publisher signing');
        run('signtool.exe', ['sign', '/sha1', values.certificate, '/fd', 'SHA256', '/tr', values.timestamp, '/td', 'SHA256', executable],
          { env, stdio: 'inherit', windowsHide: true });
      }
      const bytes = fs.readFileSync(executable);
      const signature = readSignature(executable, run);
      const manifest = { schema: 1, protocolVersion: PROTOCOL_VERSION, executable: EXECUTABLE, architecture, target: values.target,
        version: values.version, buildId, sha256: digest(bytes), imports: inspectExecutable(bytes, architecture).imports, signature };
      fs.writeFileSync(path.join(candidate, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      verifyHelper(candidate, { architecture, version: values.version, requireSignature, verifySignature: true, run });
      publish(candidate, cached);
    } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staged = fs.mkdtempSync(path.join(path.dirname(destination), '.VarinComputer-stage-'));
  try {
    fs.cpSync(cached, staged, { recursive: true });
    verifyHelper(staged, { architecture, version: values.version, requireSignature, verifySignature: true, run });
    publish(staged, destination);
  } finally { fs.rmSync(staged, { recursive: true, force: true }); }
  return { directory: destination, manifest: verifyHelper(destination, { architecture, verifySignature: false }) };
}
export function testWindowsComputerHelper({ root = repository, architecture = process.env.VARIN_TARGET_ARCH || process.arch,
  platform = process.platform, environment = process.env, run = execFileSync } = {}) {
  const { values, buildId, env } = windowsHelperBuildIdentity({ architecture, root, run, environment, platform });
  run('cargo', ['test', '--manifest-path', path.join(root, 'kernel/Cargo.toml'), '-p', 'varin-computer-windows', '--locked',
    '--target', values.target, '--target-dir', path.join(root, 'kernel/target/computer-windows')], {
    cwd: path.join(root, 'kernel'), env: { ...env, VARIN_COMPUTER_VERSION: values.version, VARIN_COMPUTER_BUILD_ID: buildId },
    stdio: 'inherit', windowsHide: true,
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--test');
  const result = buildWindowsComputerHelper({ destination: args[0] ? path.resolve(args[0]) : path.join(source, 'build') });
  console.log(`Windows Computer helper ${result.manifest.architecture}: ${result.manifest.signature.status}, ${result.directory}`);
  if (process.argv.includes('--test')) testWindowsComputerHelper();
}
