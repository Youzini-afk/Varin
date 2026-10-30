import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildMacWorkspaceHelper } from '../packages/workspace-driver/macos/build-helper.mjs';

const require = createRequire(import.meta.url);
const { defaultKernelTargetTriple, detectKernelBinaryIdentity, normalizeKernelArchitecture } = require('./kernel-binary-identity.cjs');

const root = path.resolve(import.meta.dirname, '..');
const pinnedToolchain = /^channel\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'kernel/rust-toolchain.toml'), 'utf8'))?.[1];
if (!pinnedToolchain) throw new Error('kernel/rust-toolchain.toml must declare its build toolchain');
const rustEnvironment = { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || pinnedToolchain };
const { protocolVersion } = JSON.parse(fs.readFileSync(path.join(root, 'kernel', 'protocol', 'schema.json'), 'utf8'));
const args = process.argv.slice(2);
const stageIndex = args.indexOf('--stage');
const stage = stageIndex >= 0 && args[stageIndex + 1]
  ? path.resolve(process.cwd(), args[stageIndex + 1])
  : null;
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : (process.env.VARIN_TARGET_TRIPLE || undefined);
const platformIndex = args.indexOf('--platform');
const platform = platformIndex >= 0 ? args[platformIndex + 1] : (process.env.VARIN_TARGET_PLATFORM || process.platform);
const archIndex = args.indexOf('--arch');
const arch = normalizeKernelArchitecture(archIndex >= 0 ? args[archIndex + 1] : (process.env.VARIN_TARGET_ARCH || process.arch));
const identityIndex = args.indexOf('--build-identity');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const buildIdentity = identityIndex >= 0 ? args[identityIndex + 1] : (process.env.VARIN_KERNEL_BUILD_IDENTITY || packageVersion);
if (!buildIdentity?.trim()) throw new Error('kernel build identity is required');
const prebuilt = process.env.VARIN_KERNEL_PREBUILT?.trim();
const targetTriple = target ?? defaultKernelTargetTriple(platform, arch);
const expectedTriple = defaultKernelTargetTriple(platform, arch);
if (targetTriple !== expectedTriple) throw new Error(`Kernel target triple ${targetTriple} does not match ${platform}/${arch} (${expectedTriple}).`);
const windowsQuote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const locateVsDevCmd = () => {
  if (process.platform !== 'win32' || process.env.INCLUDE) return null;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .flatMap((base) => [
      path.join(base, 'Microsoft Visual Studio', '2022', 'BuildTools', 'Common7', 'Tools', 'VsDevCmd.bat'),
      path.join(base, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'Tools', 'VsDevCmd.bat'),
      path.join(base, 'Microsoft Visual Studio', '2022', 'Professional', 'Common7', 'Tools', 'VsDevCmd.bat'),
      path.join(base, 'Microsoft Visual Studio', '2022', 'Enterprise', 'Common7', 'Tools', 'VsDevCmd.bat'),
    ]);
  return roots.find((candidate) => fs.existsSync(candidate)) ?? null;
};
const executable = platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel';
let source;
if (prebuilt) {
  source = path.resolve(process.cwd(), prebuilt);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Prebuilt Varin kernel does not exist or is not a file: ${source}`);
  }
} else {
  const hostArch = normalizeKernelArchitecture(process.arch);
  const cargoTarget = target || platform !== process.platform || arch !== hostArch ? targetTriple : undefined;
  const cargoArgs = ['build', '--manifest-path', path.join(root, 'kernel', 'Cargo.toml'), '--release', '--bin', 'varin-kernel', '--locked'];
  if (cargoTarget) cargoArgs.push('--target', cargoTarget);
  const vsDevCmd = locateVsDevCmd();
  const useWindowsEnvironment = process.platform === 'win32' && vsDevCmd;
  const command = useWindowsEnvironment ? 'cmd.exe' : (process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const commandArgs = useWindowsEnvironment
    ? ['/d', '/s', '/c', `set "VARIN_KERNEL_BUILD_IDENTITY=${buildIdentity.replaceAll('"', '')}" && set "VARIN_KERNEL_TARGET=${targetTriple.replaceAll('"', '')}" && set "VARIN_KERNEL_ARCH=${arch.replaceAll('"', '')}" && call ${windowsQuote(vsDevCmd)} -arch=${arch} -host_arch=${hostArch} && cargo.exe ${cargoArgs.map(windowsQuote).join(' ')}`]
    : cargoArgs;
  const result = useWindowsEnvironment
    ? spawnSync(commandArgs[3], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...rustEnvironment, VARIN_KERNEL_BUILD_IDENTITY: buildIdentity, VARIN_KERNEL_TARGET: targetTriple, VARIN_KERNEL_ARCH: arch },
      shell: true,
    })
    : spawnSync(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...rustEnvironment, VARIN_KERNEL_BUILD_IDENTITY: buildIdentity, VARIN_KERNEL_TARGET: targetTriple, VARIN_KERNEL_ARCH: arch },
    });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const targetDirectory = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'kernel', 'target');
  source = path.join(targetDirectory, ...(cargoTarget ? [cargoTarget] : []), 'release', executable);
}
if (!fs.existsSync(source)) throw new Error(`Rust kernel build did not produce ${source}`);
const binaryIdentity = detectKernelBinaryIdentity(fs.readFileSync(source));
if (binaryIdentity.platform !== platform || binaryIdentity.arch !== arch) {
  throw new Error(`Rust kernel binary is ${binaryIdentity.platform}/${binaryIdentity.arch}, expected ${platform}/${arch}.`);
}
if (!stage) {
  console.log(`${prebuilt ? 'Verified prebuilt' : 'Built'} Varin kernel without staging (${binaryIdentity.platform}/${binaryIdentity.arch}).`);
  process.exit(0);
}
fs.mkdirSync(stage, { recursive: true });
const destination = path.join(stage, executable);
fs.copyFileSync(source, destination);
if (platform === 'darwin') buildMacWorkspaceHelper({ destination: stage, architecture: arch, version: packageVersion });
if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
const digest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
  schema: 3,
  executable,
  targetTriple,
  platform,
  arch,
  binaryFormat: binaryIdentity.format,
  buildIdentity,
  protocolVersion,
  kernelVersion: '0.1.0',
  sha256: digest,
}, null, 2) + '\n');
console.log(`Staged ${executable} (${digest}) at ${path.relative(root, stage)}`);
