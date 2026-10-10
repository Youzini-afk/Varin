import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpAuthority } from '@varin/pi-host/mcp-authority';
import { createMcpLease } from './mcp-owner.js';
import { createChildMcpPreparer } from './mcp-child-preparation.js';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall, McpBinding } from './protocol.generated.js';
import type { McpToolLease } from './tool-bridge.js';

it('rebinds original MCP definitions to child stdio cwd across retirement, restores exact bindings and rejects unavailable dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-child-mcp-'));
  const parentCwd = path.join(root, 'parent'),
    childCwd = path.join(root, 'child');
  await fs.mkdir(parentCwd);
  await fs.mkdir(childCwd);
  await fs.writeFile(path.join(parentCwd, 'marker'), 'parent');
  await fs.writeFile(path.join(childCwd, 'marker'), 'child');
  await fs.writeFile(path.join(root, 'marker'), 'neutral');
  const script = path.join(root, 'server.mjs'),
    calls = path.join(root, 'calls.jsonl');
  await fs.writeFile(
    script,
    `import fs from 'node:fs'; import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id===undefined)return;let result;
if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(request.method==='tools/list')result={tools:[{name:'read',description:'Read the actual working view',inputSchema:{type:'object',additionalProperties:false}}]};
else if(request.method==='tools/call'){const value={cwd:process.cwd(),marker:fs.readFileSync('marker','utf8')};fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(value)+'\\n');result={content:[{type:'text',text:JSON.stringify(value)}]};}
else return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});`,
  );
  const config = {
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [script],
        exposure: 'direct',
      },
    },
  };
  await fs.writeFile(path.join(root, 'mcp.json'), JSON.stringify(config));
  const authority = new McpAuthority();
  const leases: McpToolLease[] = [];
  const kernel = {} as KernelClient; // Permission fixture explicitly allows this tool; no kernel RPC occurs.
  let allowedTool = '';
  const policy = async () => ({
    mode: 'normal' as const,
    rules: [{ tool: allowedTool, decision: 'allow' as const }],
  });
  const signal = new AbortController().signal;
  try {
    const parent = createMcpLease({
      kernel,
      currentPolicy: policy,
      lease: await authority.acquire(
        {
          agentDir: root,
          configCwd: root,
          executionCwd: parentCwd,
          environmentId: 'host:parent',
          executionScope: 'workspace',
          projectTrusted: false,
          sessionId: 'parent',
        },
        { servers: ['fixture'] },
      ),
    });
    leases.push(parent);
    const tool = parent.binding.tools.find(
      (value) => value.name !== 'mcp_call' && value.name !== 'mcp_discover',
    )!;
    allowedTool = tool.name;
    const selected: McpBinding = {
      ...structuredClone(parent.binding),
      tools: [tool],
      resources: {
        [tool.name]: parent.binding.resources[tool.name]!,
        'server:fixture': parent.binding.resources['server:fixture']!,
      },
    };
    const prepare = createChildMcpPreparer({
      authority,
      kernel,
      agentDir: root,
      hostId: 'host',
      inspectWorkspace: async () => ({ root: parentCwd }),
      projectTrusted: () => false,
      currentPolicy: policy,
    });
    const input = {
      runId: 'child-run',
      threadId: 'child-thread',
      fixed: true,
      source: {
        runId: 'child-run',
        mode: 'materialized' as const,
        workspaceId: 'workspace',
        executionWorkspaceId: 'child-execution',
        branchId: 'child-source',
        revision: 1,
        tools: [],
      },
      executionCwd: childCwd,
    };
    const child = await prepare(
      { ...input, delegatedBinding: selected },
      signal,
    );
    leases.push(child);
    expect(child.binding.reference).not.toBe(parent.binding.reference);
    expect(child.binding.resources[tool.name]).not.toBe(
      parent.binding.resources[tool.name],
    );
    expect(child.binding.tools).toEqual([tool]);
    expect(child.binding.provenance.servers.fixture!.definition_version).toBe(
      parent.binding.provenance.servers.fixture!.definition_version,
    );
    const call: HostToolCall = {
      runId: input.runId,
      origin: { kind: 'policy_action', action_id: 'action', node_id: 'node' },
      operationId: 'child-operation',
      callId: 'child-call',
      name: tool.name,
      schemaVersion: tool.version,
      arguments: {},
    };
    await child.authorize(call, signal);
    const result = await child.execute(call, signal, {
      kind: 'external',
      identity: 'child-effect',
      epoch: 'child-epoch',
    });
    expect(result).toMatchObject({
      completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed' },
      executor_stopped: true,
    });
    expect(
      (await fs.readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ cwd: childCwd, marker: 'child' }]);
    const saved = structuredClone(child.binding);
    child.release();
    const restored = await prepare(
      { ...input, requiredBinding: saved },
      signal,
    );
    leases.push(restored);
    expect(restored.binding).toEqual(saved);
    await expect(
      restored.authorize(
        {
          ...call,
          name: 'mcp_discover',
          schemaVersion: '1',
          arguments: { server: 'unselected' },
        },
        signal,
      ),
    ).rejects.toThrow('mcp_schema_changed');
    const { executionCwd: _cwd, ...readOnly } = input;
    // A global config file can still describe a workspace-scoped execution dependency.
    await expect(
      prepare(
        {
          ...readOnly,
          source: { ...input.source, mode: 'fixed_branch' },
          delegatedBinding: selected,
        },
        signal,
      ),
    ).rejects.toThrow('execution view matching its fixed source');
    const global = createMcpLease({
      kernel,
      currentPolicy: policy,
      lease: await authority.acquire(
        {
          agentDir: root,
          configCwd: root,
          executionCwd: root,
          environmentId: 'host:global',
          executionScope: 'global',
          projectTrusted: false,
          sessionId: 'global-parent',
        },
        { servers: ['fixture'] },
      ),
    });
    leases.push(global);
    const neutral = await prepare(
      { ...input, delegatedBinding: global.binding },
      signal,
    );
    leases.push(neutral);
    expect(neutral.binding.provenance.execution_scope).toBe('global');
    const neutralCall = {
      ...call,
      operationId: 'neutral-operation',
      callId: 'neutral-call',
    };
    await neutral.authorize(neutralCall, signal);
    await neutral.execute(neutralCall, signal, {
      kind: 'external',
      identity: 'neutral-effect',
      epoch: 'child-epoch',
    });
    expect(
      (await fs.readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { cwd: childCwd, marker: 'child' },
      { cwd: root, marker: 'neutral' },
    ]);
    config.mcpServers.fixture.args = [script, 'new-configuration'];
    await fs.writeFile(path.join(root, 'mcp.json'), JSON.stringify(config));
    const afterUpdate = await prepare(
      { ...input, delegatedBinding: selected },
      signal,
    );
    leases.push(afterUpdate);
    expect(afterUpdate.binding).toEqual(saved);
    await afterUpdate.authorize(
      { ...call, operationId: 'after-update', callId: 'after-update' },
      signal,
    );
    await afterUpdate.execute(
      { ...call, operationId: 'after-update', callId: 'after-update' },
      signal,
      { kind: 'external', identity: 'after-update', epoch: 'child-epoch' },
    );
    expect(
      (await fs.readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { cwd: childCwd, marker: 'child' },
      { cwd: root, marker: 'neutral' },
      { cwd: childCwd, marker: 'child' },
    ]);
    // Host restart or final original-owner release cannot synthesize the old definition.
    for (const lease of leases) lease.release();
    await expect(
      prepare({ ...input, requiredBinding: saved }, signal),
    ).rejects.toThrow('mcp_saved_definition_unavailable');
  } finally {
    for (const lease of leases) lease.release();
    await authority.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
