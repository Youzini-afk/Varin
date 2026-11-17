import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createExternalAgentsHttpAPI, ExternalAgentError } from '../src/external-agents.js';

it('reconnects installation observations on the original device without repeating mutations', async () => {
  const original = globalThis.fetch;
  const owner = { kind: 'managed_host' as const, hostId: 'target', connectionId: 'paired', endpointIdentity: 'https://target' };
  const calls: Array<{ input: { action: string; after?: string }; resourceOwner: unknown }> = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    if (calls.length === 2) return Response.json({ error: 'Connection lost' }, { status: 503 });
    return Response.json({ revision: calls.length === 1 ? 'epoch:1' : 'epoch:2', operations: [] });
  };
  try {
    const controller = new AbortController();
    const states: string[] = [];
    let disconnected = 0;
    await createExternalAgentsHttpAPI().observeInstallations(state => {
      states.push(state.revision);
      if (states.length === 2) controller.abort();
    }, controller.signal, owner, () => disconnected++);
    assert.deepEqual(states, ['epoch:1', 'epoch:2']);
    assert.equal(disconnected, 1);
    assert.deepEqual(calls.map(call => call.input), [{ action: 'state' }, { action: 'watch', after: 'epoch:1' }, { action: 'state' }]);
    assert.ok(calls.every(call => JSON.stringify(call.resourceOwner) === JSON.stringify(owner)));
    globalThis.fetch = async () => Response.json({ code: 'forbidden', error: 'Management permission required' }, { status: 403 });
    await assert.rejects(createExternalAgentsHttpAPI().observeInstallations(() => {}, new AbortController().signal, owner),
      error => error instanceof ExternalAgentError && error.status === 403);
  } finally { globalThis.fetch = original; }
});

it('preserves external configuration, explicit authentication, cancellation and continuation as distinct intents', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({});
  };
  try {
    const api = createExternalAgentsHttpAPI();
    await api.send('external:a', 'input', { text: 'hello', config: { effort: 'high', safe: 'true' } });
    await api.connect('external:a');
    await api.authenticate('external:a', 'browser');
    await api.respond('external:a', 'generation:turn:request', { cancelled: true });
    await api.stop('external:a', 'turn', true);
    await api.continueConversation('external:a');
    assert.deepEqual(calls.map((call) => call.path), ['/api/external-agents/send', '/api/external-agents/connect', '/api/external-agents/authenticate', '/api/external-agents/respond', '/api/external-agents/stop', '/api/external-agents/continue']);
    assert.deepEqual(calls[0]!.body, { id: 'external:a', key: 'input', input: { text: 'hello', config: { effort: 'high', safe: 'true' } } });
    assert.deepEqual(calls[4]!.body, { id: 'external:a', turnId: 'turn', force: true });
  } finally { globalThis.fetch = original; }
});
it('retains a safe authentication challenge rather than replacing it with generic connection failure', async () => {
  const original = globalThis.fetch;
  const authentication = { methods: [{ id: 'login', name: 'Sign in', type: 'terminal', command: 'agent', args: ['login'] }] };
  globalThis.fetch = async () => Response.json({ code: 'authentication_required', error: 'Sign in first', details: { authentication } }, { status: 401 });
  try {
    await assert.rejects(createExternalAgentsHttpAPI().connect('external:a'), (error) => error instanceof ExternalAgentError
      && error.code === 'authentication_required' && error.status === 401
      && JSON.stringify(error.details?.authentication) === JSON.stringify(authentication));
  } finally { globalThis.fetch = original; }
});

it('sends explicit current-turn and next-turn intents separately from model options', async () => {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({});
  };
  try {
    const api = createExternalAgentsHttpAPI();
    await api.send('external:a', 'supplement', { text: 'Keep this constraint' }, { mode: 'steer', expectedTurnId: 'active-turn' });
    await api.send('external:a', 'next-task', { text: 'Separate task', model: 'next-model', thinking: 'high', mode: 'plan' }, { mode: 'next_turn' });
    assert.deepEqual(calls, [
      { id: 'external:a', key: 'supplement', input: { text: 'Keep this constraint' }, options: { mode: 'steer', expectedTurnId: 'active-turn' } },
      { id: 'external:a', key: 'next-task', input: { text: 'Separate task', model: 'next-model', thinking: 'high', mode: 'plan' }, options: { mode: 'next_turn' } },
    ]);
  } finally { globalThis.fetch = original; }
});
