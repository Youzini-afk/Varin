export const resolveUpdaterChannel = ({ platform, architecture, role = 'full' }: {
  role?: 'full' | 'light';
  architecture: NodeJS.Architecture;
  platform: NodeJS.Platform;
}): 'latest-arm64' | 'light' | null => role === 'light' ? 'light' : (
  platform === 'win32' && architecture === 'arm64' ? 'latest-arm64' : null
);
