import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectTrust } from './project-trust.js';

test('shared project trust reads preserve inherited decisions, symlink identity, invalid assets and no-write reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-trust-reader-'));
  try {
    const agent = join(root, 'agent'), project = join(root, 'project');
    assert.equal(readProjectTrust(agent, project), null);
    assert.deepEqual(await readdir(root), []);
    await mkdir(agent); await mkdir(join(project, 'blocked'), { recursive: true });
    await symlink(project, join(root, 'alias'), 'dir');
    const raw = JSON.stringify({ [project]: true, [join(project, 'blocked')]: false });
    await writeFile(join(agent, 'trust.json'), '\uFEFF' + raw);
    assert.equal(readProjectTrust(agent, join(project, 'future')), true);
    assert.equal(readProjectTrust(agent, join(root, 'alias', 'blocked')), false);
    assert.equal(await readFile(join(agent, 'trust.json'), 'utf8'), '\uFEFF' + raw);
    await writeFile(join(agent, 'trust.json'), '{broken');
    assert.throws(() => readProjectTrust(agent, project));
    assert.equal(await readFile(join(agent, 'trust.json'), 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});
