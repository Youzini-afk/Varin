import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readContextPolicy } from './context-settings.js';
it('distinguishes the implicit 20K settings value from explicit trusted retention', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'context-settings-'));
  const projectRoot = path.join(root, 'project');
  const input = { agentDir: root, projectRoot, projectTrusted: false, providerId: 'p', modelId: 'm' };
  try {
    expect(await readContextPolicy(input)).toMatchObject({ keepRecentTokens: 20000, explicitKeepRecentTokens: null });
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 123, modelOverrides: { 'p/m': { keepRecentTokens: 0 } } } }));
    expect(await readContextPolicy(input)).toMatchObject({ keepRecentTokens: 0, explicitKeepRecentTokens: 0 });
    await mkdir(path.join(projectRoot, '.pi'), { recursive: true });
    await writeFile(path.join(projectRoot, '.pi/settings.json'), JSON.stringify({ compaction: { modelOverrides: { 'p/m': { keepRecentTokens: 456 } } } }));
    expect((await readContextPolicy(input)).explicitKeepRecentTokens).toBe(0);
    expect((await readContextPolicy({ ...input, projectTrusted: true })).explicitKeepRecentTokens).toBe(456);
  } finally { await rm(root, { recursive: true, force: true }); }
});
