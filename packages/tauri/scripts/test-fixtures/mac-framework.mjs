import fs from 'node:fs/promises';
import path from 'node:path';

export const frameworkPath = 'Varin.app/Contents/Frameworks/Electron Framework.framework';

/** Apple's canonical versioned framework layout, with actual alias identities. */
export async function macFrameworkFixture(directory, { architecture = 'arm64', version = '1.2.3', sourceSha = 'a'.repeat(40) } = {}) {
  const binary = Buffer.alloc(128);
  binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4);
  const write = async (name, content, mode = 0o644) => {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), content, { mode });
  };
  await write('Varin.app/Contents/MacOS/Varin', binary, 0o755);
  await write(`${frameworkPath}/Versions/A/Electron Framework`, binary, 0o755);
  await write(`${frameworkPath}/Versions/A/Resources/Info.plist`, '<plist><dict><key>CFBundlePackageType</key><string>FMWK</string></dict></plist>');
  await write(`${frameworkPath}/Versions/A/Libraries/helper.dylib`, binary, 0o755);
  await write(`${frameworkPath}/Versions/A/Helpers/crash-handler`, binary, 0o755);
  await write('varin-exporter.json', JSON.stringify({ schema: 1, protocol: 1, version, sourceSha,
    platform: 'darwin', architecture, executable: 'Varin.app/Contents/MacOS/Varin', entry: '--varin-export-private-state' }));
  const links = ['Electron Framework', 'Helpers', 'Libraries', 'Resources'].map(name => ({
    path: `${frameworkPath}/${name}`, target: `Versions/Current/${name}`,
  }));
  links.push({ path: `${frameworkPath}/Versions/Current`, target: 'A' });
  for (const link of links) await fs.symlink(link.target, path.join(directory, link.path));
  return links;
}
