import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DefaultPackageManager, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent';
import { installedAgentPackageIdentity, readAgentResourceConfiguration } from '../src/agent-resource-configuration.js';

describe('read-only installed Agent resources', () => {
  it('uses the locked SDK Git parser across URL forms and ignores npm versions while preserving scoped names', async () => {
    const git = await Promise.all([
      'git:git@github.com:example/review.git@main', 'git:https://github.com/example/review.git@v2',
      'https://github.com/example/review.git', 'ssh://git@github.com/example/review.git',
    ].map(source => installedAgentPackageIdentity(source, '/unused')));
    assert.deepEqual(new Set(git), new Set(['git:github.com/example/review']));
    assert.equal(await installedAgentPackageIdentity('npm:@example/review@1.2.3', '/unused'), 'npm:@example/review');
    assert.equal(await installedAgentPackageIdentity('npm:@example/review@next', '/unused'), 'npm:@example/review');
    assert.equal(await installedAgentPackageIdentity('npm:review@^2', '/unused'), 'npm:review');
  });

  it('reads real user/trusted project package locations without resolving, installing, reloading or importing extensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varin-resource-packages-'));
    const agentDir = join(root, 'agent'); const cwd = join(root, 'workspace'); const local = join(root, 'local');
    const userSettings = { packages: ['../local', 'npm:@example/review@1', 'git:https://github.com/example/review.git@main'] };
    const projectSettings = { packages: ['../../local-alias', 'npm:@example/review@2', 'git:git@github.com:example/review.git@next'] };
    try {
      for (const directory of [agentDir, join(cwd, '.pi'), local,
        join(agentDir, 'npm/node_modules/@example/review'), join(cwd, '.pi/npm/node_modules/@example/review'),
        join(agentDir, 'git/github.com/example/review'), join(cwd, '.pi/git/github.com/example/review')]) await mkdir(directory, { recursive: true });
      await symlink(local, join(root, 'local-alias'));
      await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'same-local', pi: { extensions: ['index.js'], skills: ['skills'] } }));
      await writeFile(join(local, 'index.js'), "throw new Error('Resources must never execute this extension');");
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify(userSettings));
      await writeFile(join(cwd, '.pi/settings.json'), JSON.stringify(projectSettings));
      const untrusted = await readAgentResourceConfiguration({ agentDir, cwd });
      assert.equal(untrusted.projectTrusted, false);
      assert.ok(untrusted.packages.every(pkg => pkg.scope === 'user'));
      new ProjectTrustStore(agentDir).set(cwd, true);
      const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const sdk = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
      const expected = sdk.listConfiguredPackages();
      const selected = await readAgentResourceConfiguration({ agentDir, cwd });
      assert.equal(selected.projectTrusted, true);
      assert.equal(selected.packages.length, 6);
      for (const pkg of selected.packages) {
        const original = expected.find(item => item.source === pkg.source && item.scope === pkg.scope)!;
        assert.equal(pkg.installedPath, await realpath(original.installedPath!));
      }
      for (const identity of [`local:${await realpath(local)}`, 'npm:@example/review', 'git:github.com/example/review']) {
        assert.deepEqual(selected.packages.filter(pkg => pkg.identity === identity).map(pkg => pkg.scope), ['user', 'project']);
      }
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')), userSettings);
      assert.deepEqual(JSON.parse(await readFile(join(cwd, '.pi/settings.json'), 'utf8')), projectSettings);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
