import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHostConnectionsHttpAPI } from '../src/host-connections.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';

// This node:test file runs in its own process. Keep a fail-closed fetch stub for
// its entire lifetime, including background URL-token work started by switching.
// Never restore native fetch while a detached authentication promise may exist.
let connectionFetch: typeof fetch = async () => { throw new Error('Unexpected fixture request'); };
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/auth/url-token')) return new Response(null, { status: 401 });
  if (!url.includes('/api/connections/')) throw new Error(`Unexpected fixture URL: ${url}`);
  return connectionFetch(input, init);
};

it('executes resource connections, probes and SSH on the selected Agent Host', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  connectionFetch = async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json({ ok: true });
  };
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://agent-host.example', runtimeKey: 'agent' });
    const api = createHostConnectionsHttpAPI();
    await api.hosts.probe({ id: 'resource', label: 'Resource', url: 'http://127.0.0.1:3000' });
    await api.ssh.connect('resource/ssh');
    await api.ssh.logs('resource/ssh');
    assert.deepEqual(calls.map(call => call.url), ['https://agent-host.example/api/connections/hosts/probe', 'https://agent-host.example/api/connections/ssh/resource%2Fssh/connect', 'https://agent-host.example/api/connections/ssh/resource%2Fssh/logs?limit=600']);
    assert.ok(calls[0]);
    assert.deepEqual(calls[0].body, { url: 'http://127.0.0.1:3000' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://agent-host.example', runtimeKey: 'agent', clientToken: 'new-fixture-principal' });
    await assert.rejects(api.hosts.set({ hosts: [], defaultHostId: null }), /Connection owner changed/);
    await assert.rejects(api.ssh.connect('resource/ssh'), /Connection owner changed/);
    assert.equal(calls.length, 3);
  } finally { connectionFetch = async () => { throw new Error('Connection fixture is closed'); }; }
});

it('does not accept a late connection response after the authenticated Host changes', async () => {
  let finish!: (value: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  connectionFetch = async () => new Promise(resolve => { finish = resolve; entered(); });
  try {
    const api = createHostConnectionsHttpAPI();
    const reading = api.hosts.get();
    await started;
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other-agent.example', runtimeKey: 'other' });
    finish(Response.json({ hosts: [{ id: 'stale' }], defaultHostId: 'stale' }));
    await assert.rejects(reading, /Connection owner changed/);
  } finally { connectionFetch = async () => { throw new Error('Connection fixture is closed'); }; }
});
