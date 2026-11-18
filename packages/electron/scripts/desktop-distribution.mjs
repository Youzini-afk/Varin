import path from 'node:path';

/** Do not infer the installed role from the machine, environment or missing artifacts. */
export function parseRoleArgument(args) {
  const options = args.filter(arg => arg.startsWith('--role'));
  if (!options.length) return 'full';
  if (options.length !== 1 || !['--role=full', '--role=light'].includes(options[0])) {
    throw new Error('Specify exactly one of --role=full or --role=light');
  }
  args.splice(args.indexOf(options[0]), 1);
  return options[0].slice('--role='.length);
}

export function assertDesktopTarget(role, platform, architecture) {
  if (role === 'full') return;
  if (role !== 'light' || !['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(architecture)) {
    throw new Error(`Unsupported desktop product: ${role}/${platform}/${architecture}`);
  }
}

export function desktopBuilderConfiguration(base, prepared, { role, platform, architecture }) {
  assertDesktopTarget(role, platform, architecture);
  const config = structuredClone(base);
  config.directories.app = prepared.directory;
  config.asarUnpack = prepared.unpackPatterns;
  if (role === 'full') return config;
  config.appId = 'dev.varin.desktop.light';
  config.productName = 'Varin Light';
  config.directories.output = path.join(path.dirname(prepared.directory), 'dist');
  const windowsArm = platform === 'win32' && architecture === 'arm64';
  config.publish = { ...config.publish, channel: windowsArm ? 'light-arm64' : 'light',
    // The release workflow deliberately does not distribution-sign macOS. Do
    // not advertise an unsigned ZIP as a Squirrel.Mac automatic update.
    ...(platform === 'darwin' ? { publishAutoUpdate: false } : {}) };
  config.mac.artifactName = 'Varin-Light-${version}-mac-${arch}.${ext}';
  config.win.artifactName = 'Varin-Light-${version}-win-${arch}.${ext}';
  // The full installer's NSIS include offers WinFsp and manages Host data.
  // Keep NSIS / OS signing itself; use the stock per-user installer for Light.
  delete config.nsis.include;
  delete config.win.extraResources;
  config.linux.executableName = 'varin-light';
  config.linux.artifactName = 'Varin-Light-${version}-linux-${arch}.${ext}';
  Object.assign(config.linux.desktop.entry, { Name: 'Varin Light', Icon: 'varin-light', StartupWMClass: 'varin-light',
    Comment: 'Connect to a Varin Agent service' });
  // Positive resource list: a stale full build or a new server driver cannot leak in.
  config.extraResources = config.extraResources.filter(item =>
    ['icons/icon.png', 'icons/icon.ico', 'icons/tray', 'legal/LICENSE', 'legal/THIRD_PARTY_NOTICES.md', 'web-dist'].includes(item.to))
    .map(item => item.to === 'web-dist' ? { ...item, from: prepared.webDist } : item);
  if (platform === 'darwin') config.extraResources.push({ from: 'resources/icons/Assets.car', to: 'Assets.car' });
  delete config.beforePack;
  delete config.afterSign;
  config.afterPack = 'scripts/verify-light-payload.cjs';
  return config;
}
