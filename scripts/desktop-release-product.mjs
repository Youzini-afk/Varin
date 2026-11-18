import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpdateManifest } from '../packages/electron/scripts/verify-update-manifest.mjs';

// The exact file inventory at the native-builder -> release assembly boundary.
// Never discover a role by globbing a directory that could contain a full build.
export function desktopReleaseProduct({ role = 'full', platform, arch, version }) {
  if (!['full', 'light'].includes(role) || !['win32', 'linux', 'darwin'].includes(platform)
    || !['x64', 'arm64'].includes(arch)) throw new Error(`Unknown release target ${role}/${platform}/${arch}`);
  const light = role === 'light';
  const channel = light ? 'light' : 'latest';
  const stem = `Varin-${light ? 'Light-' : ''}${version}-`;
  const dist = light ? `artifacts/build/desktop-light-${platform}-${arch}/dist` : 'packages/electron/dist';
  const name = light ? 'Varin Light' : 'Varin';
  const required = [], optional = [];
  let manifest, finalManifest;
  if (platform === 'linux') {
    required.push(`${stem}linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`);
    manifest = finalManifest = `${channel}-linux${arch === 'x64' ? '' : '-' + arch}.yml`;
  } else if (platform === 'win32') {
    const installer = `${stem}win-${arch}.exe`;
    required.push(installer, installer + '.blockmap');
    finalManifest = `${channel}${arch === 'arm64' ? '-arm64' : ''}.yml`;
    manifest = light ? finalManifest : 'latest.yml';
  } else {
    const base = stem + 'mac-' + arch;
    required.push(base + '.dmg', base + '.zip');
    if (!light) {
      manifest = finalManifest = 'latest-mac.yml';
      optional.push(base + '.dmg.blockmap', base + '.zip.blockmap');
    }
  }
  return { dist, name, required, optional, manifest, finalManifest };
}

export async function stageDesktopRelease(target, destination, workspace = '.') {
  const { dist: relative, required, optional, manifest } = desktopReleaseProduct(target);
  const dist = path.join(workspace, relative);
  if (manifest && target.platform !== 'darwin') verifyUpdateManifest({
    expectedVersion: target.version, manifestPath: path.join(dist, manifest), artifactPath: path.join(dist, required[0]),
  });
  await fs.mkdir(destination, { recursive: true });
  for (const name of [...required, ...(manifest ? [manifest] : [])]) await fs.copyFile(path.join(dist, name), path.join(destination, name));
  for (const name of optional) {
    try { await fs.copyFile(path.join(dist, name), path.join(destination, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = { role: process.env.VARIN_DESKTOP_ROLE || 'full', platform: process.env.VARIN_TARGET_PLATFORM,
    arch: process.env.VARIN_TARGET_ARCH, version: JSON.parse(await fs.readFile('packages/electron/package.json')).version };
  if (process.argv[2] === 'stage') await stageDesktopRelease(target, 'packages/electron/release-assets');
  else if (process.argv[2] === 'outputs') {
    const { dist, name, required, manifest } = desktopReleaseProduct(target);
    await fs.appendFile(process.env.GITHUB_OUTPUT, `dist=${dist}\nname=${name}\nasset=${required[0]}\nmanifest=${manifest ?? ''}\n`);
  } else throw new Error('Usage: desktop-release-product.mjs outputs|stage');
}
