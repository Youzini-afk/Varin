import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createExternalAgentsHttpAPI, ExternalAgentError } from '../src/external-agents.js';

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
