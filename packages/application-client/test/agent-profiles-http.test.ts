import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createAgentProfilesHttpAPI } from '../src/agent-profiles-http.js';
import { AgentProfilesError, type AgentProfileSaveRequest } from '../src/agent-profiles.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';

it('sends exact runtime-scoped tool intent and preserves safe Host failures', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let conflict = false;
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return conflict ? Response.json({ code: 'agent-settings-conflict', message: 'Agent settings changed. Reload them before saving.' }, { status: 409 })
      : Response.json({ runtime: 'agent', revision: 'committed', profiles: [], capabilities: [] });
  };
  try {
    const api = createAgentProfilesHttpAPI();
    await api.read({ runtime: 'agent' });
    const request: AgentProfileSaveRequest = { runtime: 'agent', expectedRevision: 'original', id: 'varin:builtin:worker',
      config: { kind: 'builtin', slot: 'worker', binding: { enabled: false } } };
    await api.save(request);
    await api.save({ ...request, tools: [] });
    await api.save({ ...request, tools: null });
    await api.remove({ runtime: 'agent', expectedRevision: 'original', id: 'varin:custom:helper' });
    assert.equal(calls[0]!.path, '/api/agent-profiles/read');
    assert.deepEqual(calls[0]!.body, { runtime: 'agent' });
    assert.equal(Object.hasOwn(calls[1]!.body, 'tools'), false);
    assert.deepEqual(calls[2]!.body.tools, []);
    assert.equal(calls[3]!.body.tools, null);
    assert.equal(calls[4]!.path, '/api/agent-profiles/remove');
    conflict = true;
    await assert.rejects(api.save(request), error => error instanceof AgentProfilesError
      && error.status === 409 && error.code === 'agent-settings-conflict'
      && error.message === 'Agent settings changed. Reload them before saving.');
  } finally { globalThis.fetch = original; }
});

it('rejects late response bodies after cancellation or Host switching', async () => {
  const original = globalThis.fetch;
  let release!: (value: unknown) => void;
  globalThis.fetch = async input => String(input).includes('/auth/')
    ? Response.json({ token: 'test', expiresAt: Date.now() + 60_000 })
    : { ok: true, json: () => new Promise(resolve => { release = resolve; }) } as Response;
  try {
    const api = createAgentProfilesHttpAPI();
    const controller = new AbortController();
    const aborted = api.read({ runtime: 'pi' }, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); release({ runtime: 'pi' });
    await assert.rejects(aborted, { name: 'AbortError' });
    const stale = api.read({ runtime: 'agent' });
    await new Promise(resolve => setImmediate(resolve));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://next-host.test', runtimeKey: 'next-host' });
    release({ runtime: 'agent' });
    await assert.rejects(stale, error => error instanceof AgentProfilesError && error.code === 'host-changed');
  } finally { globalThis.fetch = original; }
});
