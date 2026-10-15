#!/usr/bin/env node
/** Build the TCC-owning application into this immutable Host generation. */
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
export function buildMacComputerHelper({ destination = source, architecture = process.env.VARIN_TARGET_ARCH || process.arch,
  platform = process.platform, signIdentity = process.env.VARIN_COMPUTER_SIGN_IDENTITY || '-', run = execFileSync } = {}) {
  if (platform !== 'darwin') throw new Error('The native Computer helper requires the macOS SDK and signing tools');
  const arch = { x64: 'x86_64', arm64: 'arm64' }[architecture];
  if (!arch) throw new Error(`Unsupported macOS helper architecture: ${architecture}`);
  const bundle = join(destination, 'Varin Computer.app');
  const candidate = join(destination, `.VarinComputer-build-${process.pid}.app`);
  const executable = join(candidate, 'Contents', 'MacOS', 'VarinComputer');
  rmSync(candidate, { recursive: true, force: true });
  mkdirSync(dirname(executable), { recursive: true });
  try {
    const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    run('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-O', '-target', `${arch}-apple-macosx13.0`, '-sdk', sdk,
      ...['Native.swift', 'Capture.swift', 'Driver.swift', 'main.swift'].map(name => join(source, name)),
      '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage',
      '-framework', 'CoreMedia', '-framework', 'Carbon', '-o', executable], { stdio: 'inherit' });
    copyFileSync(join(source, 'Info.plist'), join(candidate, 'Contents', 'Info.plist'));
    // Development builds are explicitly ad-hoc. Distribution signing is done
    // with the enclosing application's team identity by electron-builder.
    run('codesign', ['--force', '--options', 'runtime', '--sign', signIdentity,
      ...(signIdentity === '-' ? [] : ['--timestamp']), candidate], { stdio: 'inherit' });
    run('codesign', ['--verify', '--strict', candidate], { stdio: 'inherit' });
    rmSync(bundle, { recursive: true, force: true });
    renameSync(candidate, bundle);
    return bundle;
  } finally { rmSync(candidate, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMacComputerHelper({ destination: process.argv[2] ? resolve(process.argv[2]) : source });
}
