import fs from 'node:fs';
import path from 'node:path';

export const assertUpdaterCapability = ({
  platform = process.platform,
  packaged,
  role = 'full',
  appImagePath = process.env.APPIMAGE,
  access = fs.accessSync,
  stat = ((p: string) => fs.statSync(p)) as (path: string) => { isFile(): boolean },
}: {
  access?: typeof fs.accessSync;
  appImagePath?: string | undefined;
  role?: 'full' | 'light';
  packaged?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  stat?: (path: string) => { isFile(): boolean };
} = {}): void => {
  if (packaged && role === 'light' && platform === 'darwin') {
    throw new Error('This macOS Light release requires a manual update. Install the matching Varin Light DMG from the release page.');
  }
  if (platform !== 'linux' || !packaged) return;

  if (!appImagePath) {
    throw new Error(
      'Updates require the packaged Linux AppImage. Start Varin from its .AppImage file, not an extracted or repackaged copy.',
    );
  }
  if (!path.isAbsolute(appImagePath)) {
    throw new Error(`Updates require APPIMAGE to be an absolute path, got: ${appImagePath}`);
  }

  try {
    if (!stat(appImagePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`The running AppImage cannot be found at ${appImagePath}. Start Varin from a valid .AppImage file.`);
  }

  try {
    access(appImagePath, fs.constants.W_OK);
  } catch {
    throw new Error(
      `The AppImage is not writable at ${appImagePath}. Move it to a writable location or grant write permission before updating.`,
    );
  }
};
