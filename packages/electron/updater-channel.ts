export const resolveUpdaterChannel = ({ platform, architecture, role = 'full' }: {
  role?: 'full' | 'light';
  architecture: NodeJS.Architecture;
  platform: NodeJS.Platform;
}): 'latest-arm64' | 'light' | 'light-arm64' | null => {
  const windowsArm = platform === 'win32' && architecture === 'arm64';
  if (role === 'light') return windowsArm ? 'light-arm64' : 'light';
  return windowsArm ? 'latest-arm64' : null;
};
