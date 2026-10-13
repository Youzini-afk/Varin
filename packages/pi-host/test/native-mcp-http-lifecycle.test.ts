import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { McpAuthority, McpAuthorityError } from '../src/mcp-authority.js';

type Rpc = { id?: number; method: string; params?: { uri?: string } };
const signal = new AbortController().signal;
function fixture(options: { changedCapabilities?: boolean; provider?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'varin-mcp-http-lifecycle-'));
  const url = 'https://fixture.invalid/mcp';
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
    url, exposure: 'deferred', ...(options.provider ? { auth: { provider: 'fixture-provider' } } : {}),
  } } }));
  const calls: { session: string | null; method: string; uri?: string | undefined }[] = [];
  const pending = new Map<string, (response: Response) => void>();
  let sessions = 0;
  const reply = (request: Rpc, result: unknown, session?: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
    headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
  });
  const requests = new Map<string, Rpc>();
  const fetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const session = new Headers(init?.headers).get('mcp-session-id');
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') { calls.push({ session, method: 'DELETE' }); return new Response(null, { status: 204 }); }
    const request = JSON.parse(String(init?.body)) as Rpc;
    calls.push({ session, method: request.method, uri: request.params?.uri });
    if (request.method === 'initialize') {
      sessions++;
      return reply(request, { protocolVersion: '2025-11-25', capabilities: {
        resources: sessions > 1 && options.changedCapabilities ? { listChanged: true } : {}, prompts: { listChanged: true },
      }, serverInfo: { name: 'http-fixture', version: '1' } }, `session-${sessions}`);
    }
    if (request.id === undefined) return new Response(null, { status: 202 });
    switch (request.method) {
      case 'resources/list': return reply(request, { resources: [] });
      case 'resources/templates/list': return reply(request, { resourceTemplates: [] });
      case 'prompts/list': return reply(request, { prompts: [{ name: 'review', description: session }] });
      case 'resources/read': {
        const uri = request.params!.uri!;
        if (uri === 'fixture:///expired') return new Response('expired', { status: 404 });
        if (uri === 'fixture:///unauthorized') return new Response('unauthorized', { status: 401 });
        if (uri.startsWith('fixture:///held')) {
          requests.set(uri, request);
          return new Promise(resolve => { pending.set(uri, resolve); });
        }
        return reply(request, { contents: [{ uri, text: session }] });
      }
      default: throw new Error(`Unexpected method: ${request.method}`);
    }
  };
  const authority = new McpAuthority({
    createTransport: (_entry, _cwd, authProvider) => new StreamableHttpTransport({ url, fetch, ...(authProvider ? { authProvider } : {}) }),
    providerToken: async () => 'fake-token',
    credentialScope: async () => ({ reference: 'fake-grant', generation: 1 }),
  });
  const scope = { agentDir: root, configCwd: root, executionCwd: root, environmentId: 'http-fixture',
    resourceOwner: { kind: 'local' as const }, executionScope: 'global' as const, projectTrusted: false, sessionId: 'one' };
  return {
    authority, scope, calls, sessions: () => sessions,
    async waitFor(uri: string) {
      const deadline = Date.now() + 3000;
      while (!pending.has(uri)) { assert.ok(Date.now() < deadline, 'HTTP request must enter original transport'); await new Promise(resolve => setImmediate(resolve)); }
    },
    finish(uri: string, expired: boolean) {
      const request = requests.get(uri)!;
      pending.get(uri)!(expired ? new Response('expired', { status: 404 }) : new Response(JSON.stringify([
        { jsonrpc: '2.0', method: 'notifications/prompts/list_changed' },
        { jsonrpc: '2.0', id: request.id, result: { contents: [{ uri, text: 'late original result' }] } },
      ]), { headers: { 'content-type': 'application/json' } }));
    },
    async close() { await authority.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('expired native HTTP requests stop without replay, and late old clients cannot disturb a new session', async () => {
  const f = fixture();
  try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    const services = await lease.discoverServices('fixture', signal);
    const resources = services.find(service => service.kind === 'resources')!;
    const prompts = services.find(service => service.kind === 'prompts')!;
    const slow = lease.requestService(resources, { operation: 'resources/read', uri: 'fixture:///held-success' }, { signal });
    const lateFailure = lease.requestService(resources, { operation: 'resources/read', uri: 'fixture:///held-expired' }, { signal });
    // Attach the rejection handler before releasing the controlled response.
    const rejectedLate = assert.rejects(lateFailure, error => error instanceof McpAuthorityError && error.dispatched && error.settlement === 'session_expired');
    await f.waitFor('fixture:///held-success'); await f.waitFor('fixture:///held-expired');
    await assert.rejects(lease.requestService(resources, { operation: 'resources/read', uri: 'fixture:///expired' }, { signal }),
      error => error instanceof McpAuthorityError && error.dispatched && error.settlement === 'session_expired' && error.code === 'mcp-session-expired');
    assert.equal(f.sessions(), 1, 'the expired operation is never replayed');
    assert.equal(lease.inspect().servers[0]!.status, 'disconnected');
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0, 'detachment must not close other in-flight requests');
    const next = await lease.requestService(resources, { operation: 'resources/read', uri: 'fixture:///new-operation' }, { signal });
    assert.deepEqual(next.result.contents, [{ uri: 'fixture:///new-operation', text: 'session-2' }]);
    const page = await lease.requestService(prompts, { operation: 'prompts/list' }, { signal });
    const listCount = f.calls.filter(call => call.method === 'prompts/list').length;
    f.finish('fixture:///held-success', false);
    assert.deepEqual((await slow).result.contents, [{ uri: 'fixture:///held-success', text: 'late original result' }]);
    await lease.preparePrompt('fixture', 'review', page.promptVersions![0]!.schemaVersion, signal);
    assert.equal(f.calls.filter(call => call.method === 'prompts/list').length, listCount, 'old-client notification cannot invalidate current descriptors');
    f.finish('fixture:///held-expired', true); await rejectedLate;
    assert.equal(lease.inspect().servers[0]!.status, 'connected', 'late old 404 must not detach the current session');
    await lease.requestService(resources, { operation: 'resources/read', uri: 'fixture:///after-late-error' }, { signal });
    assert.equal(f.sessions(), 2);
    assert.equal(f.calls.filter(call => call.uri === 'fixture:///expired').length, 1);
    lease.release();
  } finally { await f.close(); }
});

test('a new HTTP client rechecks negotiated service versions before entering a new request', async () => {
  const f = fixture({ changedCapabilities: true });
  try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    const service = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'resources')!;
    await assert.rejects(lease.requestService(service, { operation: 'resources/read', uri: 'fixture:///expired' }, { signal }));
    await assert.rejects(lease.requestService(service, { operation: 'resources/read', uri: 'fixture:///stale-version' }, { signal }),
      error => error instanceof McpAuthorityError && !error.dispatched && error.code === 'mcp-schema-generation-mismatch');
    assert.equal(f.calls.filter(call => call.uri === 'fixture:///stale-version').length, 0);
    const current = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'resources')!;
    assert.notEqual(current.schemaVersion, service.schemaVersion);
    await lease.requestService(current, { operation: 'resources/read', uri: 'fixture:///current-version' }, { signal });
    assert.equal(f.sessions(), 2); lease.release();
  } finally { await f.close(); }
});

test('native HTTP authentication failures retain the original connection owner needs-auth transition', async () => {
  const f = fixture({ provider: true });
  try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    const service = (await lease.discoverServices('fixture', signal)).find(value => value.kind === 'resources')!;
    await assert.rejects(lease.requestService(service, { operation: 'resources/read', uri: 'fixture:///unauthorized' }, { signal }),
      error => error instanceof McpAuthorityError && error.dispatched && error.settlement === 'unknown');
    assert.equal(lease.inspect().servers[0]!.status, 'needs-auth');
    assert.equal(f.calls.filter(call => call.uri === 'fixture:///unauthorized').length, 1);
    assert.equal(f.sessions(), 1); lease.release();
  } finally { await f.close(); }
});
