import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthority, McpCompositions, type McpAuthorityOptions, type McpCompositionSelection } from '../src/mcp-authority.js';

type Factory = NonNullable<McpAuthorityOptions['createTransport']>;
function fixture(withTools = false) {
  const root = mkdtempSync(join(tmpdir(), 'varin-mcp-services-'));
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture', exposure: 'deferred' } } }));
  let promptDescription = 'original', calls = 0, lists = 0, transports = 0;
  let held: ((value: Record<string, unknown>) => void) | undefined;
  let blockList = false, blockInitialization = false;
  let notify: (method: string) => void = () => { };
  const createTransport: Factory = () => {
    transports++;
    type Transport = ReturnType<Factory>;
    const listeners = new Set<Parameters<Transport['onMessage']>[0]>();
    notify = method => { for (const listener of listeners) listener({ jsonrpc: '2.0', method }); };
    return {
      async start() { }, async close() { }, onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onError() { return () => { }; }, onClose() { return () => { }; },
      async send(message) {
        if (!('method' in message) || !('id' in message)) return;
        const reply = (result: Record<string, unknown>) => { for (const listener of listeners) listener({ jsonrpc: '2.0', id: message.id, result }); };
        switch (message.method) {
          case 'initialize': if (blockInitialization) return; return reply({ protocolVersion: '2025-11-25', capabilities: { resources: {}, prompts: { listChanged: true }, ...(withTools ? { tools: {} } : {}) }, serverInfo: { name: 'fixture', version: '1' } });
          case 'tools/list': return reply({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
          case 'resources/list': return reply({ resources: [{ name: 'one', uri: 'fixture:///one', _meta: { item: true } }], nextCursor: 'page-2', _meta: { page: true } });
          case 'resources/templates/list': return reply({ resourceTemplates: [] });
          case 'prompts/list': {
            lists++;
            const result = { prompts: [{ name: 'review', description: promptDescription, arguments: [{ name: 'constructor', required: true }], _meta: { item: true } }], _meta: { page: true } };
            if (blockList) { held = reply; return; }
            return reply(result);
          }
          case 'resources/read': calls++; return reply({ contents: [{ uri: (message.params as { uri: string }).uri, text: 'resource text', blob: 'YmluYXJ5', mimeType: 42 }], _meta: { read: true } });
          case 'prompts/get': calls++; return reply({ messages: [{ role: 'user', content: { type: 'text', text: 'External prompt' } }], _meta: { get: true } });
          default: throw new Error(`Unexpected ${message.method}`);
        }
      },
    };
  };
  const authority = new McpAuthority({ createTransport });
  const scope = { agentDir: root, configCwd: root, executionCwd: root, environmentId: 'host:global', resourceOwner: { kind: 'local' as const }, executionScope: 'global' as const, projectTrusted: false, sessionId: 'fixture' };
  return {    
authority, scope, root, counts: () => ({ calls, lists, transports }), change: () => { promptDescription = 'changed'; notify('notifications/prompts/list_changed'); },
    blockInitialization: () => { blockInitialization = true; },
    block: () => { blockList = true; }, finish: (result: Record<string, unknown>) => { blockList = false; held?.(result); },
    close: async () => { await authority.close(); rmSync(root, { recursive: true, force: true }); }  
};
}
const signal = new AbortController().signal;
test('provenance freezes each real scope owner and rejects changed owners before transport entry', async () => {
  const f = fixture();
  try {
    const local = await f.authority.acquire(f.scope, { servers: [] });
    const original = local.binding.provenance.servers.fixture!;
    assert.deepEqual(original.owner, { resource_owner: { kind: 'local' },
      configuration: { agent_dir: f.root, config_cwd: f.root, project_trusted: false }, execution_scope: 'global' });
    assert(Object.isFrozen(original.owner));
    assert(Object.isFrozen(original.owner.resource_owner));
    assert(Object.isFrozen(original.owner.configuration));
    const resourceOwner = { kind: 'managed_host' as const, hostId: 'host', connectionId: 'connection', endpointIdentity: 'endpoint' };
    const managed = await f.authority.acquire({ ...f.scope, resourceOwner }, { servers: [] });
    assert.notEqual(managed.binding.reference, local.binding.reference);
    assert.notEqual(managed.binding.provenance.servers.fixture!.resource_key, original.resource_key);
    resourceOwner.hostId = 'changed-after-acquisition';
    assert.deepEqual(managed.binding.provenance.servers.fixture!.owner.resource_owner,
      { kind: 'managed_host', hostId: 'host', connectionId: 'connection', endpointIdentity: 'endpoint' });
    for (const change of ['resource', 'configuration', 'execution', 'missing'] as const) {
      const provenance = structuredClone(local.binding.provenance);
      const owner = provenance.servers.fixture!.owner;
      if (change === 'resource') owner.resource_owner = resourceOwner;
      if (change === 'configuration') owner.configuration.project_trusted = true;
      if (change === 'execution') owner.execution_scope = 'workspace';
      if (change === 'missing') Reflect.deleteProperty(provenance.servers.fixture!, 'owner');
      await assert.rejects(f.authority.acquire(f.scope, { servers: ['fixture'], provenance }), /mcp_configuration_source_changed/);
    }
    const changedDefinition = structuredClone(local.binding.provenance);
    changedDefinition.servers.fixture!.definition_version = 'unavailable-original';
    await assert.rejects(f.authority.acquire(f.scope, { servers: ['fixture'], provenance: changedDefinition }), /mcp_saved_definition_unavailable/);
    assert.equal(f.counts().transports, 0);
    managed.release(); local.release();
  } finally { await f.close(); }
});

test('retargeting derives a new execution resource from the original owner and retained immutable definition', async () => {
  const f = fixture();
  try {
    const original = await f.authority.acquire(f.scope, { servers: [] });
    writeFileSync(join(f.root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'replacement', exposure: 'deferred' } } }));
    const child = await f.authority.acquire({ ...f.scope, executionCwd: join(f.root, 'child'), environmentId: 'child', sessionId: 'child' },
      { servers: [], provenance: original.binding.provenance });
    const selected = child.binding.provenance.servers.fixture!;
    assert.deepEqual(selected.owner, original.binding.provenance.servers.fixture!.owner);
    assert.equal(selected.definition_version, original.binding.provenance.servers.fixture!.definition_version);
    assert.notEqual(selected.resource_key, original.binding.provenance.servers.fixture!.resource_key);
    const current = await f.authority.acquire(f.scope, { servers: [] });
    assert.notEqual(current.binding.provenance.servers.fixture!.definition_version, selected.definition_version);
    const wrongOwner = structuredClone(original.binding.provenance);
    wrongOwner.servers.fixture!.owner.resource_owner = { kind: 'managed_host', hostId: 'host', connectionId: 'connection', endpointIdentity: 'endpoint' };
    await assert.rejects(f.authority.acquire(f.scope, { servers: ['fixture'], provenance: wrongOwner }), /mcp_configuration_source_changed/);
    child.release(); original.release(); current.release();
    await assert.rejects(f.authority.acquire(f.scope, { servers: ['fixture'], provenance: original.binding.provenance }), /mcp_saved_definition_unavailable/);
    assert.equal(f.counts().transports, 0);
  } finally { await f.close(); }
});

test('resource/prompt requests retain protocol metadata and exact versions through the original tools-free connection', async () => {
  const f = fixture();
  try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    assert.equal(lease.inspect().connectedServerCount, 0);
    const services = await lease.discoverServices('fixture', signal);
    const resources = services.find(value => value.kind === 'resources')!, prompts = services.find(value => value.kind === 'prompts')!;
    assert.equal(lease.inspect().connectedServerCount, 1);
    const page = await lease.requestService(resources, { operation: 'resources/list', cursor: 'opaque-cursor' }, { signal });
    assert.deepEqual(page.result._meta, { page: true }); assert.equal(page.result.nextCursor, 'page-2');
    const read = await lease.requestService(resources, { operation: 'resources/read', uri: 'fixture:///not-listed' }, { signal });
    assert.deepEqual(read.result.contents, [{ uri: 'fixture:///not-listed', text: 'resource text', blob: 'YmluYXJ5', mimeType: 42 }]);
    const list = await lease.requestService(prompts, { operation: 'prompts/list' }, { signal });
    assert.deepEqual(list.result._meta, { page: true });
    const version = list.promptVersions![0]!.schemaVersion;
    const before = f.counts().lists;
    const prompt = await lease.preparePrompt('fixture', 'review', version, signal);
    assert.equal(f.counts().lists, before, 'current declaration reuse makes no extra remote listing');
    await assert.rejects(lease.requestService(prompts, { operation: 'prompts/get', prompt, arguments: {} }, { signal }), /arguments[-_]invalid/);
    const got = await lease.requestService(prompts, { operation: 'prompts/get', prompt, arguments: { constructor: 'x', extra: 'allowed by protocol' } }, { signal });
    assert.deepEqual(got.result._meta, { get: true });
    f.change();
    assert.throws(() => lease.validateServiceRequest(prompts, { operation: 'prompts/get', prompt, arguments: { constructor: 'x' } }), /schema-generation-mismatch/);
    await assert.rejects(lease.preparePrompt('fixture', 'review', version, signal), /schema-generation-mismatch/);
    assert.equal(f.counts().calls, 2);
    lease.release();
  } finally { await f.close(); }
});
test('a prompt-list change during an outstanding response cannot resurrect its old cached declaration', async () => {
  const f = fixture();
  try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    const service = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'prompts')!;
    f.block();
    const pending = lease.requestService(service, { operation: 'prompts/list' }, { signal });
    await new Promise(resolve => setImmediate(resolve));
    f.change();
    f.finish({ prompts: [{ name: 'review', description: 'original', arguments: [{ name: 'constructor', required: true }] }] });
    const old = await pending;
    await assert.rejects(lease.preparePrompt('fixture', 'review', old.promptVersions![0]!.schemaVersion, signal), /schema-generation-mismatch/);
    assert.equal(f.counts().calls, 0);
    lease.release();
  } finally { await f.close(); }
});

test('service dispatch distinguishes pre-entry rejection from cancelled dispatched work', async () => {
  const f = fixture();
  try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    const service = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'prompts')!;
    const before = f.counts().lists;
    await assert.rejects(lease.requestService(service, { operation: 'prompts/list' }, { signal, beforeDispatch: () => { throw new Error('policy changed'); } }),
      error => error instanceof Error && 'dispatched' in error && error.dispatched === false);
    assert.equal(f.counts().lists, before);
    f.block();
    const controller = new AbortController();
    const pending = lease.requestService(service, { operation: 'prompts/list' }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counts().lists, before + 1);
    controller.abort();
    await assert.rejects(pending, error => error instanceof Error && 'dispatched' in error && error.dispatched === true);
    f.finish({ prompts: [] });
    assert.equal(f.counts().lists, before + 1, 'cancellation does not replay the protocol request');
    lease.release();
  } finally { await f.close(); }
});

const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture state did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('a retained deferred service admission is revoked by explicit server hiding', async () => {
  const f = fixture(), compositions = new McpCompositions(f.authority, () => { });
  try {
    const scope = await compositions.observe(f.scope, () => { });
    const lease = scope.snapshot();
    const service = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'resources')!;
    const revoked = lease.serviceRevocationSignal(service);
    writeFileSync(join(f.root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture', exposure: 'hidden' } } }));
    await until(() => revoked.aborted);
    assert.throws(() => lease.assertService(service), /revoked/);
    lease.release(); scope.release();
  } finally { compositions.close(); await f.close(); }
});

test('a preparing replacement gateway cannot retarget discovery or restore from the frozen ready contribution', async () => {
  const f = fixture(true), compositions = new McpCompositions(f.authority, () => { });
  writeFileSync(join(f.root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture', exposure: 'direct' } } }));
  try {
    let updates = 0;
    const scope = await compositions.observe(f.scope, () => { updates++; });
    await until(() => updates > 0);
    // The direct candidate publishes after its original connection is ready.
    await until(() => f.authority.inspect(f.scope).connectedServerCount === 1);
    await new Promise(resolve => setImmediate(resolve));
    const lease = scope.snapshot();
    const original = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'resources')!;
    f.blockInitialization();
    const previous = updates;
    writeFileSync(join(f.root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'replacement', exposure: 'direct' } } }));
    await until(() => updates > previous);
    const retained = scope.snapshot();
    assert.deepEqual(retained.binding.provenance.servers.fixture, lease.binding.provenance.servers.fixture);
    assert(Object.isFrozen(retained.binding.provenance.servers.fixture!.owner));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const selected = (await retained.discoverServices('fixture', controller.signal)).find(value => value.kind === 'resources')!;
      assert.equal(selected.schemaVersion, original.schemaVersion);
      await retained.requestService(selected, { operation: 'resources/read', uri: 'fixture:///retained' }, { signal });
      const selection: McpCompositionSelection = {
        provenance: retained.binding.provenance,
        tools: retained.binding.tools.map(tool => ({ name: tool.name, version: tool.schemaVersion })),
        resources: Object.fromEntries(retained.binding.tools.map(tool => [tool.name, tool.resourceKey])),
        routes: Object.fromEntries(retained.binding.tools.map(tool => [tool.name, { kind: 'direct' as const }])),
      };
      assert.equal(selection.tools.length, 1);
      const restored = await scope.restore(selection, controller.signal);
      assert.deepEqual(restored.binding.provenance, retained.binding.provenance);
      restored.release();
      const serviceOnly = await scope.restore({ ...selection, tools: [], resources: {}, routes: {} }, controller.signal);
      assert.deepEqual(serviceOnly.binding.provenance, retained.binding.provenance);
      const restoredService = (await serviceOnly.discoverServices('fixture', controller.signal)).find(value => value.kind === 'resources')!;
      assert.equal(restoredService.schemaVersion, original.schemaVersion);
      await serviceOnly.requestService(restoredService, { operation: 'resources/read', uri: 'fixture:///restored' }, { signal });
      serviceOnly.release();
      const otherOwner = structuredClone(selection);
      otherOwner.provenance.servers.fixture!.owner.resource_owner = { kind: 'managed_host', hostId: 'other', connectionId: 'connection', endpointIdentity: 'endpoint' };
      await assert.rejects(scope.restore(otherOwner, controller.signal), /mcp_saved_definition_unavailable/);
    } finally { clearTimeout(timeout); }
    retained.release(); lease.release(); scope.release();
  } finally { compositions.close(); await f.close(); }
});
