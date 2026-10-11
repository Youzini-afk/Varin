import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthority, McpAuthorityError, type McpAuthorityOptions, type McpResourceChange } from '../src/mcp-authority.js';
const signal = new AbortController().signal;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(subscribe = true) {
  const root = mkdtempSync(join(tmpdir(), 'varin-mcp-resources-'));
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { peer: { url: 'https://fixture.invalid/mcp', exposure: 'deferred', auth: { provider: 'fixture' } } } }));
  type Factory = NonNullable<McpAuthorityOptions['createTransport']>;
  let grant = 1, held = false, rejectSubscribe = false, rejectCleanup = false;
  const pending: Array<() => void> = [], sent: Array<Record<string, unknown>> = [];
  const peers: Array<{ notify(params: Record<string, unknown>): void }> = [];
  const createTransport: Factory = () => {
    type Transport = ReturnType<Factory>;
    const listeners = new Set<Parameters<Transport['onMessage']>[0]>();
    const receive = (value: unknown) => { for (const listener of listeners) listener(value as Parameters<Parameters<Transport['onMessage']>[0]>[0]); };
    peers.push({ notify: params => receive({ jsonrpc: '2.0', method: 'notifications/resources/updated', params }) });
    return { async start() {}, async close() {}, onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onError() { return () => {}; }, onClose() { return () => {}; },
      async send(message) {
        sent.push(message as unknown as Record<string, unknown>);
        if (!('method' in message) || !('id' in message)) return;
        const reply = (result: unknown) => receive({ jsonrpc: '2.0', id: message.id, result });
        switch (message.method) {
          case 'initialize': return reply({ protocolVersion: '2025-11-25', capabilities: { resources: { subscribe } }, serverInfo: { name: 'peer', version: '1' } });
          case 'resources/list': return reply({ resources: [] });
          case 'resources/templates/list': return reply({ resourceTemplates: [] });
          case 'resources/subscribe': if(rejectSubscribe){receive({jsonrpc:'2.0',id:message.id,error:{code:-32042,message:'Review subscription',data:{original:['subscribe',false,0]}}});return;} if (held) pending.push(() => reply({ _meta: { accepted: true } })); else reply({ _meta: { accepted: true } }); return;
          case 'resources/unsubscribe': if(rejectCleanup){receive({jsonrpc:'2.0',id:message.id,error:{code:-32042,message:'Review cleanup',data:{original:['unsubscribe',false,0]}}});return;} return reply({ _meta: { released: true } });
          default: throw new Error(`Unexpected ${message.method}`);
        }
      } };
  };
  const authority = new McpAuthority({ createTransport, providerToken: async () => `token-${grant}`, credentialScope: async () => ({ reference: `grant-${grant}`, generation: 1 }) });
  const scope = { agentDir: root, configCwd: root, executionCwd: root, environmentId: 'host:global', executionScope: 'global' as const, projectTrusted: false, sessionId: 'thread:one' };
  return { authority, scope, sent, peers, rejectSubscribe(){rejectSubscribe=true;}, rejectCleanup(){rejectCleanup=true;}, hold() { held = true; }, finish() { held = false; for (const release of pending.splice(0)) release(); }, changeGrant() { grant++; },
    async close() { await authority.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('original client shares exact URI holders across Threads and contains nonexact notification bodies', async () => {
  const f = fixture(); try {
    const one = await f.authority.acquire(f.scope, { servers: [] }), two = await f.authority.acquire({ ...f.scope, sessionId: 'thread:two' }, { servers: [] });
    const service = (await one.discoverServices('peer', signal))[0]!, service2 = (await two.discoverServices('peer', signal))[0]!;
    const a: McpResourceChange[] = [], b: McpResourceChange[] = [], c: McpResourceChange[] = [];
    const first = await one.observeResource(service, 'opaque:parent', { signal, onChange: change => a.push(change) });
    const second = await two.observeResource(service2, 'opaque:parent', { signal, onChange: change => b.push(change) });
    const child = await two.observeResource(service2, 'opaque:child', { signal, onChange: change => c.push(change) });
    assert.equal(f.peers.length, 1); assert.equal(f.sent.filter(m => m.method === 'resources/subscribe').length, 2);
    one.release(); two.release();
    f.peers[0]!.notify({ uri: 'opaque:child', _meta: { private: 'child-only' } }); await tick();
    assert.deepEqual(a, [{ kind: 'unresolved_association' }]); assert.deepEqual(b, a);
    assert.deepEqual(c, [{ kind: 'updated', notification: { uri: 'opaque:child', _meta: { private: 'child-only' } } }]);
    assert.deepEqual(await first.detach(), { status: 'shared' }); assert.equal(f.sent.filter(m => m.method === 'resources/unsubscribe').length, 0);
    f.peers[0]!.notify({ uri: 'opaque:parent', _meta: { retained: true } }); await tick();
    assert.equal(a.length, 1); assert.equal(b.at(-1)?.kind, 'updated');
    assert.deepEqual(await second.detach(), { status: 'acknowledged', acknowledgement: { _meta: { released: true } } }); assert.deepEqual(await child.detach(), { status: 'acknowledged', acknowledgement: { _meta: { released: true } } });
    assert.equal(f.sent.filter(m => m.method === 'resources/unsubscribe').length, 2);
    assert.equal(f.sent.filter(m => m.method === 'resources/read').length, 0);
  } finally { await f.close(); }
});
test('a pre-ACK cancellation detaches synchronously without cancelling another shared subscriber', async () => {
  const f = fixture(); try {
    const lease = await f.authority.acquire(f.scope, { servers: [] });
    const service = (await lease.discoverServices('peer', signal))[0]!;
    f.hold(); const abort = new AbortController(), a: McpResourceChange[] = [], b: McpResourceChange[] = [];
    const first = lease.observeResource(service, 'opaque:shared', { signal: abort.signal, onChange: change => a.push(change) });
    const rejected = assert.rejects(first, /subscribe-interrupted/);
    await tick();
    const second = lease.observeResource(service, 'opaque:shared', { signal, onChange: change => b.push(change) }); await tick();
    f.peers[0]!.notify({ uri: 'opaque:shared', _meta: { beforeAck: true } }); await tick();
    assert.equal(a.length, 1); assert.equal(b.length, 1);
    abort.abort(); f.peers[0]!.notify({ uri: 'opaque:shared', _meta: { afterAbort: true } }); await tick();
    assert.equal(a.length, 1); assert.equal(b.length, 2);
    f.finish(); await rejected; const observer = await second;
    assert.equal(f.sent.filter(m => m.method === 'resources/subscribe').length, 1);
    assert.equal(f.sent.filter(m => m.method === 'resources/unsubscribe').length, 0);
    assert.deepEqual(await observer.detach(), { status: 'acknowledged', acknowledgement: { _meta: { released: true } } }); lease.release();
  } finally { f.finish(); await f.close(); }
});
test('capability refusal and changed original credentials never deliver a raw body through a replacement owner', async () => {
  const no = fixture(false); try {
    const lease = await no.authority.acquire(no.scope, { servers: [] }); const service = (await lease.discoverServices('peer', signal))[0]!;
    await assert.rejects(lease.observeResource(service, 'opaque:x', { signal, onChange() {} }), /subscribe-unsupported/);
    assert.equal(no.sent.filter(m => m.method === 'resources/subscribe').length, 0); lease.release();
  } finally { await no.close(); }
  const f = fixture(); try {
    const lease = await f.authority.acquire(f.scope, { servers: [] }); const service = (await lease.discoverServices('peer', signal))[0]!;
    const changes: McpResourceChange[] = []; const observer = await lease.observeResource(service, 'opaque:x', { signal, onChange: change => changes.push(change) });
    f.changeGrant(); f.peers[0]!.notify({ uri: 'opaque:x', _meta: { secret: 'old-owner' } }); await tick();
    assert(changes.some(change => change.kind === 'unavailable')); assert(!changes.some(change => change.kind === 'updated'));
    assert.deepEqual(await observer.detach(), { status: 'unknown' }); lease.release();
  } finally { await f.close(); }
});

test('resource RPC errors keep their full protocol bodies separately from holder removal and cleanup uncertainty', async () => {
  const f=fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:[]}),service=(await lease.discoverServices('peer',signal))[0]!;
    const observer=await lease.observeResource(service,'opaque:accepted',{signal,onChange(){}});
    f.rejectCleanup();
    assert.deepEqual(await observer.detach(),{status:'unknown',protocolError:{code:-32042,message:'Review cleanup',data:{original:['unsubscribe',false,0]}}});
    f.rejectSubscribe();
    await assert.rejects(lease.observeResource(service,'opaque:refused',{signal,onChange(){}}),error=>{
      assert.ok(error instanceof McpAuthorityError);assert.equal(error.settlement,'rpc_response');
      assert.deepEqual(error.protocolError,{code:-32042,message:'Review subscription',data:{original:['subscribe',false,0]}});return true;
    });
    assert.equal(f.sent.filter(m=>m.method==='resources/subscribe').length,2);
    assert.equal(f.sent.filter(m=>m.method==='resources/unsubscribe').length,1,'a rejected subscribe creates no remote accepted subscription to clean');
    lease.release();
  }finally{await f.close();}
});
