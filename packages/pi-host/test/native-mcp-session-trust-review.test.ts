import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequest, isRuntimeMethod, VARIN_PROTOCOL_VERSION, type HostMethod, type HostMethodParams, type HostMethodResult, type McpOwnerRequest, type SessionSnapshot, type WireEnvelope } from '@varin/protocol';
import { HostController } from '../src/host-controller.js';
import { MemoryHostTransport } from '../src/transport.js';
import { McpAuthority, mcpHostProjectTrusted } from '../src/mcp-authority.js';
import { createMcpHarnessServices } from '../../web/application-host/lib/harness/mcp-service.js';
import type { HarnessServiceContext } from '../../web/application-host/lib/harness/router.js';

it('session-only trust reaches the Host MCP owner through out-of-band settings.context while configuration is queued', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-mcp-session-trust-'));
  const agentDir = join(root, 'agent'); const cwd = join(root, 'trusted-once'); const other = join(root, 'untrusted');
  await mkdir(agentDir); for (const dir of [cwd, other]) {
    await mkdir(join(dir, '.pi'), { recursive: true });
    await writeFile(join(dir, '.pi', 'settings.json'), '{}');
    await writeFile(join(dir, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { project_fixture: { command: 'local-fixture-never-executed', exposure: 'direct' } } }));
  }
  let serial = 0; let trust = true; let actor: HarnessServiceContext | undefined;
  let contextReads = 0; const started: string[] = []; const errors: unknown[] = [];
  const authority = new McpAuthority({ createTransport: (_entry, executionCwd) => {
    const listeners = new Set<(message: any) => void>();
    return { async start() { started.push(executionCwd); }, async close() {}, onMessage(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }, onError() { return () => {}; }, onClose() { return () => {}; }, async send(message) {
      if (!('method' in message) || !('id' in message)) return;
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } } : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      for (const listener of listeners) listener({ jsonrpc: '2.0', id: message.id, result });
    } };
  } });
  class Transport extends MemoryHostTransport {
    override send(envelope: WireEnvelope) {
      super.send(envelope);
      if (envelope.kind !== 'event') return;
      if (envelope.event === 'project.trust.request') queueMicrotask(() => { void request('project.trust.respond', { requestId: envelope.data.id, trusted: trust, remember: false }).catch(error => errors.push(error)); });
      if (envelope.event === 'harness.request') {
        const event = envelope.data;
        queueMicrotask(() => {
          const ctx = actor;
          const work = event.method === 'mcp.owner' && ctx ? service.services['mcp.owner'].handle(event.params as McpOwnerRequest, ctx) : Promise.resolve({});
          void work.then(result => request('harness.respond', { sessionId: ctx?.sessionId ?? '', requestId: event.requestId, ok: true, result }), error => {
            errors.push(error); return request('harness.respond', { sessionId: ctx?.sessionId ?? '', requestId: event.requestId, ok: false, error: { code: 'failed', message: String(error) } });
          }).catch(error => errors.push(error));
        });
      }
    }
  }
  const transport = new Transport();
  async function request<M extends HostMethod>(method: M, params: HostMethodParams<M>): Promise<HostMethodResult<M>> {
    const id = `review-${++serial}`; transport.receive(createRequest(id, method, params));
    const response = await transport.waitFor(entry => entry.kind === 'response' && entry.id === id, 8_000);
    assert.ok(response.kind === 'response' && response.ok, JSON.stringify(response));
    return response.result as HostMethodResult<M>;
  }
  const service = createMcpHarnessServices(authority, async ctx => {
    const settings = await request('settings.context', {}); contextReads++;
    const configCwd = ctx.actor.cwd ?? ctx.actor.authorityRoot ?? agentDir;
    if (resolve(settings.cwd) !== resolve(configCwd)) throw new Error('MCP session configuration scope changed');
    return { agentDir, configCwd, executionCwd: ctx.actor.cwd ?? agentDir, environmentId: 'review', executionScope: 'workspace', projectTrusted: settings.projectTrusted, sessionId: ctx.sessionId };
  });
  const controller = new HostController({ agentDir, transport }); controller.start();
  const bind = (snapshot: SessionSnapshot): HarnessServiceContext => ({ sessionId: snapshot.sessionId, workspaceId: 'review', actor: { authorityInstanceId: 'review', workerId: 'review', workerGeneration: ++serial, sessionId: snapshot.sessionId, cwd: snapshot.cwd, authorityRoot: root, workspaceId: 'review', grantedCapabilities: [] }, authorizedPaths: [], signal: new AbortController().signal });
  try {
    await request('host.handshake', { clientName: 'review', clientVersion: '1', mode: 'test', protocolVersions: [VARIN_PROTOCOL_VERSION] });
    actor = bind(await request('session.create', { cwd }));
    assert.equal(mcpHostProjectTrusted(agentDir, cwd), false, 'once trust must not become durable trust');
    assert.deepEqual(await request('settings.context', {}), { cwd, projectTrusted: true });
    const catalog = await request('mcp.config.snapshot', {});
    assert.ok(catalog.catalog?.servers.some(server => server.name === 'project_fixture'), JSON.stringify(catalog));
    assert.ok(contextReads > 0, 'queued snapshot must service a nested context request');
    const opened = await service.services['mcp.owner'].handle({ operation: 'open' }, actor);
    assert.ok(opened.scope && opened.config?.servers[0]);
    const connected = await service.services['mcp.owner'].handle({ operation: 'connect', scope: opened.scope, entry: opened.config.servers[0] }, actor);
    assert.equal(connected.connection?.state, 'connected');
    assert.deepEqual(started, [cwd], 'only the trusted project may start MCP');
    assert.equal(isRuntimeMethod('settings.context'), false, 'scope read is not renderer API');
    const old = actor;
    trust = false;
    actor = bind(await request('session.create', { cwd: other }));
    assert.deepEqual(await request('settings.context', {}), { cwd: other, projectTrusted: false });
    await assert.rejects(service.services['mcp.owner'].handle({ operation: 'open' }, old), /scope changed/);
    await assert.rejects(service.services['mcp.owner'].handle({ operation: 'snapshot', scope: opened.scope, handle: connected.connection!.handle }, actor), /not owned/);
    service.disposeSession(old.sessionId);
    await assert.rejects(service.services['mcp.owner'].handle({ operation: 'snapshot', scope: opened.scope, handle: connected.connection!.handle }, old), /not owned/);
    const untrusted = await request('mcp.config.snapshot', {});
    assert.deepEqual(untrusted.catalog?.servers, []);
    assert.deepEqual(started, [cwd]);
    assert.deepEqual(errors, []);
  } finally { await controller.dispose(); service.dispose(); await authority.close(); await rm(root, { recursive: true, force: true }); }
});
