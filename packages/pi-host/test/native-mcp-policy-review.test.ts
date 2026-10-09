import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateGate } from '@varin/protocol';
import { readMcpHostPermissionPolicy } from '../src/mcp-host-configuration.js';

test('production MCP policy reads enforce trust and surface malformed settings instead of defaulting to consent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-mcp-policy-review-'));
  const agent = path.join(root, 'agent'); const project = path.join(root, 'project');
  await fs.mkdir(agent); await fs.mkdir(path.join(project, '.pi'), { recursive: true });
  const globalFile = path.join(agent, 'settings.json'); const projectFile = path.join(project, '.pi', 'settings.json');
  try {
    const global = { harness: { permissions: { mode: 'normal', rules: [{ tool: 'fixture_send', decision: 'allow' }] } } };
    await fs.writeFile(globalFile, JSON.stringify(global));
    await fs.writeFile(projectFile, JSON.stringify({ harness: { permissions: { mode: 'normal', rules: [{ tool: 'fixture_send', decision: 'deny' }] } } }));
    assert.equal(evaluateGate('fixture_send', {}, readMcpHostPermissionPolicy(agent, project, false)).decision, 'allow');
    assert.equal(evaluateGate('fixture_send', {}, readMcpHostPermissionPolicy(agent, project, true)).decision, 'deny');
    await fs.writeFile(globalFile, '{broken');
    assert.throws(() => readMcpHostPermissionPolicy(agent, project, true));
    await fs.writeFile(globalFile, JSON.stringify({ harness: { permissions: { mode: 'not-a-policy', rules: [] } } }));
    assert.throws(() => readMcpHostPermissionPolicy(agent, project, true));
    await fs.writeFile(globalFile, JSON.stringify(global));
    await fs.writeFile(projectFile, '{broken');
    assert.throws(() => readMcpHostPermissionPolicy(agent, project, true));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
