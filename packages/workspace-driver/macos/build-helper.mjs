import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plist = body => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
const entry = (key, value) => `<key>${key}</key><string>${escape(value)}</string>`;
export function buildMacWorkspaceHelper({ destination, architecture = process.arch, platform = process.platform,
  signIdentity = process.env.VARIN_WORKSPACE_SIGN_IDENTITY || '-', profile = process.env.VARIN_WORKSPACE_PROVISIONING_PROFILE,
  version = '1.0', run = execFileSync } = {}) {
  if (platform !== 'darwin') throw new Error('Building the workspace extension requires the macOS 26 SDK');
  const arch = { x64: 'x86_64', arm64: 'arm64' }[architecture];
  if (!arch || !destination) throw new Error('A supported architecture and owned staging directory are required');
  const bundle = path.join(destination, 'VarinWorkspace.app');
  const candidate = path.join(destination, `.VarinWorkspace-${process.pid}.app`);
  const extension = path.join(candidate, 'Contents', 'PlugIns', 'VarinWorkspace.appex');
  const executable = path.join(candidate, 'Contents', 'MacOS', 'VarinWorkspace');
  const module = path.join(extension, 'Contents', 'MacOS', 'VarinWorkspace');
  const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const sdkVersion = run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { encoding: 'utf8' }).trim();
  if (Number(sdkVersion.split('.')[0]) < 26) throw new Error('The path-backed FSKit extension needs macOS SDK 26 or later');
  fs.rmSync(candidate, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(module), { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  try {
    const common = ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-parse-as-library', '-O', '-sdk', sdk];
    run('xcrun', [...common, '-target', `${arch}-apple-macosx26.0`, '-application-extension',
      ...['Wire.swift', 'Volume.swift', 'Extension.swift'].map(file => path.join(source, file)),
      '-framework', 'FSKit', '-o', module], { stdio: 'inherit' });
    run('xcrun', [...common, '-target', `${arch}-apple-macosx13.0`, path.join(source, 'Control.swift'),
      '-framework', 'AppKit', '-weak_framework', 'FSKit', '-o', executable], { stdio: 'inherit' });
    const base = id => entry('CFBundleIdentifier', id) + entry('CFBundleExecutable', 'VarinWorkspace') + entry('CFBundleName', 'Varin Workspace')
      + entry('CFBundleVersion', version) + entry('CFBundleShortVersionString', version);
    fs.writeFileSync(path.join(candidate, 'Contents', 'Info.plist'), plist(base('com.varin.workspace') + entry('CFBundlePackageType', 'APPL')
      + entry('LSMinimumSystemVersion', '13.0') + '<key>LSUIElement</key><true/>'));
    fs.writeFileSync(path.join(extension, 'Contents', 'Info.plist'), plist(base('com.varin.workspace.filesystem') + entry('CFBundlePackageType', 'XPC!')
      + entry('LSMinimumSystemVersion', '26.0') + '<key>EXAppExtensionAttributes</key><dict>' + entry('EXExtensionPointIdentifier', 'com.apple.fskit.fsmodule')
      + entry('FSShortName', 'varin') + '<key>FSRequiresSecurityScopedPathURLResources</key><true/><key>FSSupportsBlockResources</key><false/>'
      + '<key>FSSupportsPathURLs</key><true/><key>FSMediaTypes</key><dict/><key>FSPersonalities</key><dict/></dict>'));
    if (profile) fs.copyFileSync(profile, path.join(extension, 'Contents', 'embedded.provisionprofile'));
    const signing = ['--force', '--options', 'runtime', '--sign', signIdentity, ...(signIdentity === '-' ? [] : ['--timestamp'])];
    run('codesign', [...signing, '--entitlements', path.join(source, 'Extension.entitlements'), extension], { stdio: 'inherit' });
    run('codesign', [...signing, candidate], { stdio: 'inherit' });
    run('codesign', ['--verify', '--strict', '--deep', candidate], { stdio: 'inherit' });
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(candidate, bundle);
    return bundle;
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMacWorkspaceHelper({ destination: path.resolve(process.argv[2]), architecture: process.argv[3] || process.arch });
}
