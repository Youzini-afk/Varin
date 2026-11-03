import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopAppsOwner } from './desktop-apps.js';
import { readLinuxDesktopEntries, buildLinuxOpenSpecs, buildLinuxInstalledApps } from './linux-app-discovery.js';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-desktop-apps-')); roots.push(root);
  const applications = path.join(root, 'share', 'applications'); await mkdir(applications, { recursive: true });
  const script = path.join(root, 'record.cjs');const receipt = path.join(root, 'receipt.json');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));`);
  const icon = path.join(root, 'fixture.png');await writeFile(icon, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', 'base64'));
  // This fixture exercises Linux desktop-entry grammar on every test runner.
  // Raw Windows backslashes are escapes in that file format, not path separators.
  // Forward slashes also resolve on Windows; the target argument stays untouched.
  const program = process.execPath.replaceAll('\\', '/');
  const scriptArgument = script.replaceAll('\\', '/');
  await writeFile(path.join(applications, 'fixture.desktop'), `[Desktop Entry]\nType=Application\nName=Fixture Editor\nExec="${program}" "${scriptArgument}" %F\nIcon=${icon.replaceAll('\\', '/')}\n`);
  await writeFile(path.join(applications, 'hidden.desktop'), '[Desktop Entry]\nType=Application\nName=Hidden App\nExec=hidden\nNoDisplay=true\n');
  const project = path.join(root, "project with spaces; $(false)");await mkdir(project);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'share'));vi.stubEnv('XDG_DATA_DIRS', path.join(root, 'empty'));
  const opened: string[] = [];const shown: string[] = [];const updates: unknown[] = [];
  const owner = createDesktopAppsOwner({ dataDirectory: root, async openPath(target) { opened.push(target); }, async showItemInFolder(target) { shown.push(target); }, fileIcon: async () => null, updated: apps => { updates.push(apps); } });
  return { root, applications, receipt, project, opened, shown, updates, owner, program, scriptArgument };
}
it('uses the original desktop-entry owner and keeps target arguments out of a shell', async () => {
  const f = await fixture();
  const entries = await readLinuxDesktopEntries({ applicationDirs: [f.applications] });
  expect(entries.map(entry => entry.name)).toEqual(['Fixture Editor']);
  expect(buildLinuxOpenSpecs({ targetPath: f.project, appId: 'fixture', appName: 'Fixture Editor', entries, env: {} })).toEqual([{ program: f.program, args: [f.scriptArgument, f.project] }]);
  expect(await buildLinuxInstalledApps(['Fixture Editor', 'Missing'], { entries, env: {} })).toEqual([{ name: 'Fixture Editor', iconDataUrl: expect.stringContaining('data:image/png;base64,') }]);
  await f.owner.dispose();
});
it.skipIf(process.platform !== 'linux')('launches the discovered application and reuses the original local cache/event shape', async () => {
  const f = await fixture();
  expect(await f.owner.invoke({ command: 'desktop_filter_installed_apps', args: { apps: ['Fixture Editor', 'Missing'] } })).toEqual(['Fixture Editor']);
  await f.owner.invoke({ command: 'desktop_open_in_app', args: { projectPath: f.project, appId: 'fixture', appName: 'Fixture Editor' } });
  await expect.poll(async () => { try { return JSON.parse(await readFile(f.receipt, 'utf8')); } catch { return null; } }).toEqual([f.project]);
  expect(await f.owner.invoke({ command: 'desktop_get_installed_apps', args: { apps: ['Fixture Editor'] } })).toEqual({ apps: [], hasCache: false, isCacheStale: true });
  await expect.poll(() => f.updates.length).toBe(1);
  const cached = await f.owner.invoke({ command: 'desktop_get_installed_apps', args: { apps: ['Fixture Editor'] } });
  expect(cached).toMatchObject({ hasCache: true, isCacheStale: false, apps: [{ name: 'Fixture Editor' }] });
  expect(JSON.parse(await readFile(path.join(f.root, 'discovered-apps.json'), 'utf8'))).toHaveProperty('updatedAt');
  await f.owner.dispose();
});
it.skipIf(process.platform !== 'linux')('delegates default open/reveal to native primitives and rejects missing targets', async () => {
  const f = await fixture();const file = path.join(f.project, 'actual.txt');await writeFile(file, 'content');
  await f.owner.invoke({ command: 'desktop_open_in_app', args: { projectPath: f.project, appId: 'finder', appName: 'Files' } });
  await f.owner.invoke({ command: 'desktop_open_file_in_app', args: { filePath: file, appId: 'finder', appName: 'Files' } });
  expect(f.opened).toEqual([f.project]);expect(f.shown).toEqual([file]);
  await expect(f.owner.invoke({ command: 'desktop_open_file_in_app', args: { filePath: path.join(f.root, 'missing'), appId: 'finder', appName: 'Files' } })).rejects.toThrow('does not exist');
  await expect(f.owner.invoke({ command: 'arbitrary' })).rejects.toThrow('Unknown');
  await f.owner.dispose();await expect(f.owner.invoke({ command: 'desktop_get_installed_apps' })).rejects.toThrow('stopped');
});
