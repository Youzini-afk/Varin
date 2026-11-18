import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  buildLinuxAutostartDesktopEntry,
  readLinuxAutostartEnabled,
  resolveLinuxAutostartFilePath,
  resolveLinuxLaunchExecutable,
  setLinuxAutostartEnabled,
} from './linux-autostart.js';

test('prefers APPIMAGE path for Linux autostart Exec', () => {
  assert.equal(
    resolveLinuxLaunchExecutable({
      env: { APPIMAGE: '/home/user/Varin.AppImage' },
      execPath: '/tmp/.mount_Varin/varin',
    }),
    '/home/user/Varin.AppImage',
  );
});

test('builds a background autostart desktop entry', () => {
  const entry = buildLinuxAutostartDesktopEntry({
    executable: '/home/user/Varin Desktop.AppImage',
    backgroundArg: '--background',
  });
  assert.match(entry, /Type=Application/);
  assert.match(entry, /Exec="\/home\/user\/Varin Desktop\.AppImage" --background/);
  assert.match(entry, /StartupWMClass=varin/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
});

test('writes and removes the XDG autostart file', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-autostart-'));
  const env = { XDG_CONFIG_HOME: path.join(homeDir, 'config') };
  const filePath = resolveLinuxAutostartFilePath({ env, homeDir });
  assert.equal(path.basename(filePath), 'varin.desktop');

  try {
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);

    const enabled = await setLinuxAutostartEnabled({
      enabled: true,
      backgroundArg: '--background',
      env: { ...env, APPIMAGE: '/opt/Varin.AppImage' },
      homeDir,
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.filePath, filePath);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);

    const contents = await fs.readFile(filePath, 'utf8');
    assert.match(contents, /Exec=\/opt\/Varin\.AppImage --background/);

    const disabled = await setLinuxAutostartEnabled({
      enabled: false,
      env,
      homeDir,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('enabling or removing light autostart leaves an installed full application alone', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-autostart-roles-'));
  const env = { XDG_CONFIG_HOME: homeDir };
  try {
    const full = await setLinuxAutostartEnabled({ env, enabled: true, execPath: '/opt/varin' });
    const light = await setLinuxAutostartEnabled({ env, role: 'light', enabled: true, execPath: '/opt/varin-light' });
    assert.notEqual(full.filePath, light.filePath);
    assert.match(await fs.readFile(light.filePath, 'utf8'), /StartupWMClass=varin-light/);
    await setLinuxAutostartEnabled({ env, role: 'light', enabled: false });
    assert.equal(await readLinuxAutostartEnabled({ env }), true);
    assert.match(await fs.readFile(full.filePath, 'utf8'), /Exec=\/opt\/varin\n/);
  } finally { await fs.rm(homeDir, { recursive: true, force: true }); }
});
