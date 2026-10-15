import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSettingsService } from '../models/settings.js';
import { parsePackageSkillManifest, readResourceSettings } from './configuration.js';
import { readAgentResourceConfiguration } from './packages.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('native package admission reads only selected settings, resolves explicit installed assets and never installs', async () => {
  const data = await mkdtemp(join(tmpdir(), 'varin-native-packages-')); roots.push(data);
  const project = join(data, 'project');
  await mkdir(join(data, 'resources', 'local'), { recursive: true });
  await mkdir(join(data, 'resources', 'downloaded')); await symlink('local', join(data, 'resources', 'alias'), 'dir');
  await mkdir(join(project, '.varin', 'resources', 'project-package'), { recursive: true });
  await mkdir(join(project, '.pi'), { recursive: true });
  await writeFile(join(project, '.pi', 'settings.json'), '{legacy broken');
  await writeFile(join(data, 'settings.json'), '{legacy broken');
  let trusted = false;
  const settings = new AgentSettingsService(data, () => trusted);
  const initial = await settings.snapshot();
  const resources = { packages: ['alias', { source: 'npm:@varin/test@1', installedPath: 'downloaded' }, 'npm:not-installed@9'] };
  const saved = await settings.update({ scope: 'global', expectedRevision: initial.globalRevision, set: { resources }, remove: [] });
  await writeFile(join(project, '.varin', 'settings.json'), JSON.stringify({ resources: { packages: ['project-package'] } }));
  const read = () => readAgentResourceConfiguration({ dataDirectory: data, settings, cwd: project });
  expect((await read()).packages).toEqual([
    { identity: `local:${join(data, 'resources', 'local')}`, installedPath: join(data, 'resources', 'local'), source: 'alias', scope: 'user' },
    { identity: 'npm:@varin/test', installedPath: join(data, 'resources', 'downloaded'), source: 'npm:@varin/test@1', scope: 'user' },
  ]);
  trusted = true;
  expect((await read()).packages.map(value => value.scope)).toEqual(['user', 'user', 'project']);
  // Discovery binds to the resource capture's exact document despite a later configuration edit.
  await settings.update({ scope: 'global', expectedRevision: saved.globalRevision, set: { resources: { packages: [] } }, remove: [] });
  expect((await readAgentResourceConfiguration({ dataDirectory: data, settings, resources: readResourceSettings({ resources }) })).packages).toHaveLength(2);
  await writeFile(join(project, '.varin', 'settings.json'), '{bad later edit');
  const projectCapture = await readAgentResourceConfiguration({ dataDirectory: data, settings, cwd: project, resources: readResourceSettings({ resources: { packages: ['project-package'] } }) });
  expect(projectCapture.packages).toHaveLength(1);
  trusted = false;
  expect((await readAgentResourceConfiguration({ dataDirectory: data, settings, cwd: project, resources: readResourceSettings({ resources: { packages: ['project-package'] } }) })).packages).toEqual([]);
  expect(await readdir(join(data, 'resources'))).toEqual(['alias', 'downloaded', 'local']);
  expect(await readFile(join(project, '.pi', 'settings.json'), 'utf8')).toBe('{legacy broken');
});
it('native resource settings and manifests validate without treating legacy manifests as native packages', () => {
  expect(parsePackageSkillManifest('{"varin":{"skills":["skills"]}}')).toEqual({ hasManifest: true, skills: ['skills'] });
  expect(() => parsePackageSkillManifest('{"pi":{"skills":["skills"]}}')).toThrow('native varin manifest');
  expect(() => readResourceSettings({ resources: null })).toThrow();
  expect(() => readResourceSettings({ resources: { packages: [''] } })).toThrow();
  expect(() => readResourceSettings({ resources: { packages: [{ source: 'npm:a', installedPath: false }] } })).toThrow();
});
