import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpToolName } from '@earendil-works/pi-coding-agent';
import { composeMcpAuthorityLeases } from '../src/mcp-lease-composition.js';
import type {
  McpAuthorityLease, McpAuthorityTool, McpAuthorityService, McpTaskLease, McpResourceObserver,
} from '../src/mcp-authority.js';

// These are controlled lease ports. This suite tests the real composition adapter and naming
// helper, not SDK transport, connection retention, credentials, or remote task execution.
const signal = new AbortController().signal;
function descriptor(server: string, tool: string, owner: string, name = createMcpToolName(server, tool)): McpAuthorityTool {
  return { name, server, tool, schemaVersion: `${owner}:${server}:${tool}:v1`, resourceKey: `${owner}:${server}`,
    configurationScope: 'global', executionScope: 'global', inputSchema: { type: 'object' },
    description: tool, exposure: 'direct', taskSupport: 'optional', taskCapable: true };
}
function fixture(owner: string, names: string[], tools: McpAuthorityTool[] = []) {
  const calls: { operation: string; args: unknown[] }[] = [];
  const record = (operation: string, ...args: unknown[]) => { calls.push({ operation, args }); };
  const revoked = new AbortController();
  const endpoint = (server: string) => ({ server, resourceKey: `${owner}:${server}`,
    configurationVersion: `${owner}:definition`, credentialVersion: `${owner}:credential` });
  const service = (server: string, kind: 'resources' | 'prompts' = 'resources'): McpAuthorityService =>
    ({ server, kind, resourceKey: `${owner}:${server}`, schemaVersion: `${owner}:${kind}:v1` });
  const servers = names.map(name => ({ name, description: owner, resourceKey: `${owner}:${name}`, hasDirectTools: true,
    exposure: 'direct' as const, configurationScope: 'global' as const, executionScope: 'global' as const,
    status: 'connected' as const, cachedToolCount: tools.filter(tool => tool.server === name).length,
    connectedToolCount: tools.filter(tool => tool.server === name).length, selected: true }));
  const inspection = { configErrorCount: 0, configuredServerCount: servers.length, connectedServerCount: servers.length,
    cachedToolCount: tools.length, servers };
  const taskResponse = { task: { taskId: 'retained', status: 'working' as const, createdAt: '2026-10-13T00:00:00Z',
    lastUpdatedAt: '2026-10-13T00:00:00Z', ttl: null }, result: {} };
  const tasks: McpTaskLease = {
    endpoint: endpoint(names[0] ?? 'empty'),
    start: async (...args) => { record('task.start', ...args); return taskResponse; },
    get: async (...args) => { record('task.get', ...args); return taskResponse; },
    result: async (...args) => { record('task.result', ...args); return {}; },
    cancel: async (...args) => { record('task.cancel', ...args); return taskResponse; },
    onChange: listener => { record('task.onChange', listener); return () => record('task.unlisten'); },
    release: () => record('task.release'),
  };
  const observer: McpResourceObserver = {
    endpoint: tasks.endpoint, listenerId: `${owner}:listener`, acknowledgement: { [owner]: true },
    detach: async options => { record('observer.detach', options); return { status: 'acknowledged', acknowledgement: { [owner]: true } }; },
  };
  const lease: McpAuthorityLease = {
    implementationIdentity: `${owner}:implementation`,
    binding: { reference: `${owner}:reference`, generation: owner === 'A' ? 1 : 2, tools,
      provenance: { servers: Object.fromEntries(names.map(name => [name, {
        owner: { resource_owner: { kind: 'managed_host' as const, hostId: owner, connectionId: `${owner}:connection`, endpointIdentity: `${owner}:endpoint` },
          configuration: { agent_dir: `/${owner}/agent`, config_cwd: `/${owner}/project`, project_trusted: true }, execution_scope: 'global' as const },
        definition_version: `${owner}:definition`, resource_key: `${owner}:${name}`,
      }])) }, readiness: inspection, servers,
      serverSelections: names.map(name => ({ name, configurationVersion: `${owner}:definition`, hiddenTools: [] })) },
    inspect: () => { record('inspect'); return inspection; },
    discover: async (...args) => { record('discover', ...args); return tools.filter(tool => tool.server === args[0]); },
    prepareTool: async (...args) => { record('prepareTool', ...args); const found = tools.find(tool => tool.server === args[0] && tool.tool === args[1] && tool.schemaVersion === args[2]); assert(found); return found; },
    discoverServices: async (...args) => { record('discoverServices', ...args); return [service(args[0])]; },
    prepareService: async (...args) => { record('prepareService', ...args); return service(args[0], args[1]); },
    preparePrompt: async (...args) => { record('preparePrompt', ...args); return { service: service(args[0], 'prompts'), name: args[1], schemaVersion: args[2], declaration: { name: args[1] } }; },
    assertService: (...args) => record('assertService', ...args),
    serviceRevocationSignal: (...args) => { record('serviceRevocationSignal', ...args); return revoked.signal; },
    validateServiceRequest: (...args) => record('validateServiceRequest', ...args),
    requestService: async (...args) => { record('requestService', ...args); return { result: { owner } }; },
    assertCallable: (...args) => record('assertCallable', ...args),
    revocationSignal: (...args) => { record('revocationSignal', ...args); return revoked.signal; },
    validateArguments: (...args) => record('validateArguments', ...args),
    callTool: async (...args) => { record('callTool', ...args); return { content: [{ type: 'text', text: owner }] }; },
    resourceEndpoint: (...args) => { record('resourceEndpoint', ...args); return endpoint(args[0].server); },
    observeResource: async (...args) => { record('observeResource', ...args); return observer; },
    taskOwner: async (...args) => { record('taskOwner', ...args); return tasks; },
    release: () => record('release'),
  };
  return { lease, calls, inspection, tools, service, revoked, tasks, observer };
}

test('selects original owners and readiness without starting or inspecting a dependency', () => {
  const a = fixture('A', ['global', 'shadowed'], [descriptor('global', 'read', 'A'), descriptor('shadowed', 'write', 'A')]);
  const b = fixture('B', ['project'], [descriptor('project', 'search', 'B')]);
  const empty = fixture('invalid', []); empty.inspection.configErrorCount = 2;
  const lease = composeMcpAuthorityLeases([{ lease: b.lease, servers: ['project'] },
    { lease: a.lease, servers: ['global'] }, { lease: empty.lease, servers: [] }]);
  assert.equal(a.calls.length, 0); assert.equal(b.calls.length, 0);
  assert.deepEqual(Object.keys(lease.binding.provenance.servers), ['global', 'project']);
  assert.deepEqual(lease.binding.provenance.servers.global, a.lease.binding.provenance.servers.global);
  assert.deepEqual(lease.binding.provenance.servers.project, b.lease.binding.provenance.servers.project);
  assert.equal(lease.binding.readiness.configErrorCount, 2);
  assert.equal(lease.binding.readiness.configuredServerCount, 2);
  assert.equal(lease.binding.readiness.connectedServerCount, 2);
  assert.equal(lease.binding.readiness.cachedToolCount, 2);
  assert.deepEqual(lease.binding.serverSelections.map(server => server.name), ['global', 'project']);
  assert(Object.isFrozen(lease.binding.provenance.servers.global!.owner.configuration));
  assert(Object.isFrozen(lease.binding.tools[0]!.inputSchema));
  assert(Object.isFrozen(lease.binding.servers[0]));
  a.inspection.servers[0]!.cachedToolCount = 9;
  assert.equal(lease.inspect().cachedToolCount, 10);
  assert.equal(lease.binding.readiness.cachedToolCount, 2);
  assert.throws(() => lease.assertCallable(a.tools[1]!.name, a.tools[1]!.schemaVersion), /mcp_target_unbound/);
  lease.release();
  assert.equal(empty.calls.filter(call => call.operation === 'release').length, 1);
});

test('composition identity and initial collision aliases are independent of input order', async () => {
  const build = (reverse: boolean) => {
    const collision = createMcpToolName('alpha', 'read');
    const a = fixture('A', ['alpha'], [descriptor('alpha', 'read', 'A', collision)]);
    const b = fixture('B', ['beta'], [descriptor('beta', 'read', 'B', collision)]);
    const parts = [{ lease: a.lease, servers: ['alpha'] }, { lease: b.lease, servers: ['beta'] }];
    return { a, b, lease: composeMcpAuthorityLeases(reverse ? parts.reverse() : parts) };
  };
  const first = build(false), second = build(true);
  assert.deepEqual(first.lease.binding, second.lease.binding);
  assert.equal(first.lease.implementationIdentity, second.lease.implementationIdentity);
  assert.equal(new Set(first.lease.binding.tools.map(tool => tool.name)).size, 2);
  const args = { value: 3 }, options = { signal, schemaVersion: first.a.tools[0]!.schemaVersion, beforeDispatch: () => {} };
  const alpha = first.lease.binding.tools.find(tool => tool.server === 'alpha')!;
  await first.lease.callTool(alpha.name, args, options);
  assert.deepEqual(first.a.calls.at(-1), { operation: 'callTool', args: [first.a.tools[0]!.name, args, options] });
  assert.equal(first.b.calls.length, 0);
  first.lease.release(); second.lease.release();
});

test('late discovery and exact preparation keep published aliases and dispatch to original names', async () => {
  const a = fixture('A', ['alpha'], [descriptor('alpha', 'first', 'A', createMcpToolName('beta', 'late'))]);
  const b = fixture('B', ['beta']);
  const lease = composeMcpAuthorityLeases([{ lease: a.lease, servers: ['alpha'] }, { lease: b.lease, servers: ['beta'] }]);
  const original = lease.binding.tools[0]!;
  const late = descriptor('beta', 'late', 'B', original.name); late.exposure = 'deferred'; b.tools.push(late);
  const discovered = (await lease.discover('beta', signal))[0]!;
  assert.notEqual(discovered.name, original.name);
  assert.equal((await lease.prepareTool('beta', late.tool, late.schemaVersion, signal)).name, discovered.name);
  lease.assertCallable(discovered.name, discovered.schemaVersion);
  lease.validateArguments(discovered.name, discovered.schemaVersion, { x: true });
  const revocation = lease.revocationSignal(discovered.name, discovered.schemaVersion);
  assert.equal(revocation, b.revoked.signal);
  await lease.callTool(discovered.name, {}, { schemaVersion: discovered.schemaVersion, signal });
  for (const operation of ['assertCallable', 'validateArguments', 'revocationSignal', 'callTool'])
    assert.equal(b.calls.find(call => call.operation === operation)!.args[0], late.name);
  lease.assertCallable(original.name, original.schemaVersion);
  assert.equal(a.calls.at(-1)!.args[0], original.name);
  b.revoked.abort(); assert(revocation.aborted);
  assert.throws(() => lease.assertCallable(discovered.name, 'wrong-version'), /mcp_target_unbound/);
  await assert.rejects(lease.discover('unselected', signal), /mcp_target_unbound/);
  lease.release();
});

test('routes services, prompts, resources and tasks to their retained owner without replacing handles', async () => {
  const a = fixture('A', ['global']), b = fixture('B', ['project']);
  const lease = composeMcpAuthorityLeases([{ lease: a.lease, servers: ['global'] }, { lease: b.lease, servers: ['project'] }]);
  const service = (await lease.discoverServices('project', signal))[0]!;
  await lease.prepareService('project', 'resources', service.schemaVersion, signal);
  await lease.preparePrompt('project', 'review', 'saved-prompt-version', signal);
  lease.assertService(service);
  assert.equal(lease.serviceRevocationSignal(service), b.revoked.signal);
  const request = { operation: 'resources/read' as const, uri: 'project:///private' };
  const options = { signal, beforeDispatch: () => {}, interaction: { operationId: 'operation', executionOwner: { kind: 'external' as const, identity: 'executor', epoch: 'epoch' } } };
  lease.validateServiceRequest(service, request);
  await lease.requestService(service, request, options);
  const endpoint = lease.resourceEndpoint(service);
  const observeOptions = { ...options, onChange: () => {} };
  const observer = await lease.observeResource(service, request.uri, observeOptions);
  const task = await lease.taskOwner('project', endpoint, signal);
  assert.equal(observer, b.observer); assert.equal(task, b.tasks);
  assert.equal(a.calls.length, 0);
  assert.deepEqual(b.calls.find(call => call.operation === 'requestService')!.args, [service, request, options]);
  assert.deepEqual(b.calls.find(call => call.operation === 'observeResource')!.args, [service, request.uri, observeOptions]);
  assert.deepEqual(b.calls.find(call => call.operation === 'taskOwner')!.args, ['project', endpoint, signal]);
  lease.release();
  assert(!b.calls.some(call => call.operation === 'task.release' || call.operation === 'observer.detach'));
  await task.get('retained', signal); await observer.detach(); task.release();
  assert.throws(() => lease.inspect(), /mcp_lease_released/);
  assert.throws(() => lease.assertService(service), /mcp_lease_released/);
  assert.throws(() => lease.taskOwner('project', endpoint, signal), /mcp_lease_released/);
});

test('rejects ambiguous or absent servers without taking ownership and releases all successful parts once', () => {
  const a = fixture('A', ['one', 'two']), b = fixture('B', ['one']);
  assert.throws(() => composeMcpAuthorityLeases([{ lease: a.lease, servers: ['one'] }, { lease: b.lease, servers: ['one'] }]), /duplicate_server/);
  assert.throws(() => composeMcpAuthorityLeases([{ lease: a.lease, servers: ['missing'] }]), /mcp_target_unbound/);
  assert.throws(() => composeMcpAuthorityLeases([{ lease: a.lease, servers: ['toString'] }]), /mcp_target_unbound/);
  assert.equal(a.calls.length, 0); assert.equal(b.calls.length, 0);
  const lease = composeMcpAuthorityLeases([{ lease: a.lease, servers: ['one'] }, { lease: a.lease, servers: ['two'] }, { lease: b.lease, servers: [] }]);
  a.lease.release = () => { a.calls.push({ operation: 'release', args: [] }); throw new Error('release fault'); };
  assert.throws(() => lease.release(), /mcp_composition_release_failed/);
  lease.release();
  assert.equal(a.calls.filter(call => call.operation === 'release').length, 1);
  assert.equal(b.calls.filter(call => call.operation === 'release').length, 1);
  const empty = composeMcpAuthorityLeases([]);
  assert.equal(empty.inspect().configuredServerCount, 0); empty.release();
});

test('a discovery finishing after release cannot publish new callable targets', async () => {
  const a = fixture('A', ['server']);
  let finish!: (tools: McpAuthorityTool[]) => void;
  a.lease.discover = () => new Promise(resolve => { finish = resolve; });
  const lease = composeMcpAuthorityLeases([{ lease: a.lease, servers: ['server'] }]);
  const pending = lease.discover('server', signal);
  lease.release(); finish([descriptor('server', 'late', 'A')]);
  await assert.rejects(pending, /mcp_lease_released/);
  assert.equal(a.calls.filter(call => call.operation === 'release').length, 1);
});
