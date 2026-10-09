import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAuthStorageBackend, McpOAuthCredentialStore } from '@earendil-works/pi-coding-agent';
import { McpAuthority, type McpAuthorityOptions } from '../src/mcp-authority.js';

type Factory = NonNullable<McpAuthorityOptions['createTransport']>;
function transport(calls: string[]): Factory {
  return (_entry, _cwd, auth) => {
    type Transport = ReturnType<Factory>;
    const listeners = new Set<Parameters<Transport['onMessage']>[0]>();
    return {
      async start() { await auth?.token(); }, async close() {},
      onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onError() { return () => {}; }, onClose() { return () => {}; },
      async send(message) {
        if (!('method' in message) || !('id' in message)) return;
        let result: Record<string, unknown>;
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'grant-fixture', version: '1' } };
        else if (message.method === 'tools/list') result = { tools: [{ name: 'send', inputSchema: { type: 'object', additionalProperties: false } }] };
        else if (message.method === 'tools/call') { calls.push(message.method); result = { content: [{ type: 'text', text: 'sent' }] }; }
        else throw new Error(`Unexpected fixture method ${message.method}`);
        for (const listener of listeners) listener({ jsonrpc: '2.0', id: message.id, result });
      },
    };
  };
}

for (const mode of ['provider', 'oauth'] as const) it(`${mode} grants preserve token refresh, reject replacement and persisted old targets without replay`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'varin-mcp-grant-'));
  const url = 'https://fixture.invalid/mcp';
  const calls: string[] = [];
  let token = 'fake-token-one';
  let grant = { reference: 'fake-grant', generation: 1, authority: 'fixture', account: 'account-one' };
  const store = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(root, 'mcp-auth.json')), root);
  const server = store.forServer('fixture', url);
  const initial = { serverUrl: url, oauthState: 'fake-first-authorization', tokens: { access_token: token, token_type: 'Bearer' } };
  await server.save(initial);
  const firstBinding = store.binding('fixture', url);
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { url, exposure: 'direct', ...(mode === 'provider' ? { auth: { provider: 'fixture-provider' } } : {}) } } }));
  const authority = new McpAuthority({ createTransport: transport(calls), providerToken: async () => token, credentialScope: async () => grant });
  const scope = { agentDir: root, configCwd: root, executionCwd: root, environmentId: 'fixture', executionScope: 'global' as const, projectTrusted: false, sessionId: 'one' };
  const signal = new AbortController().signal;
  try {
    const lease = await authority.acquire(scope, { servers: ['fixture'] });
    const target = lease.binding.tools[0]; assert.ok(target);
    token = 'fake-refreshed-token';
    await server.save({ ...initial, tokens: { access_token: token, token_type: 'Bearer' } });
    assert.deepEqual(store.binding('fixture', url), firstBinding);
    await lease.callTool(target.name, {}, { schemaVersion: target.schemaVersion, signal });
    assert.equal(calls.length, 1);
    if (mode === 'provider') grant = { ...grant, generation: 2, account: 'account-two' };
    if (mode === 'oauth') await server.save({ ...initial, oauthState: 'fake-second-authorization', tokens: { access_token: 'fake-other-account', token_type: 'Bearer' } });
    if (mode === 'oauth') assert.notDeepEqual(store.binding('fixture', url), firstBinding);
    await assert.rejects(lease.callTool(target.name, {}, { schemaVersion: target.schemaVersion, signal }), /credential-revoked|owner-revoked/);
    assert.equal(calls.length, 1, 'revoked call must never reach transport or replay');
    const replacement = await authority.acquire({ ...scope, sessionId: 'two' }, { servers: ['fixture'] });
    assert.notEqual(replacement.binding.tools[0]?.schemaVersion, target.schemaVersion);
    await assert.rejects(replacement.prepareTool('fixture', 'send', target.schemaVersion, signal), /schema-generation-mismatch/);
    assert.equal(calls.length, 1);
    replacement.release(); lease.release();
  } finally { await authority.close(); rmSync(root, { recursive: true, force: true }); }
});
