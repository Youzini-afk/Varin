/** Prepare synthetic state exclusively through the normal authenticated Host
 * contracts. A completed HTTP dispatch alone is never a completed seed turn. */
import { seedPrompt } from './benchmark-fixture-service.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function fixtureApi(origin, credentials) {
  const endpoint = new URL(origin);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || !credentials?.clientToken) throw new Error('Expected isolated loopback Host credentials');
  return async (route, body) => {
    if (!route.startsWith('/api/')) throw new Error('Only product API routes are permitted');
    const response = await fetch(new URL(route, endpoint), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.clientToken}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error(`Product fixture API ${route} returned ${response.status}`);
    return response.json();
  };
}
export async function awaitRun(api, runId, { timeoutMs = 90000 } = {}) {
  if (typeof runId !== 'string' || !runId) throw new Error('Product admission did not identify its real Run');
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const run = await api('/api/threads/run', { runId });
    if (run.state === 'completed') return run;
    if (['failed', 'cancelled'].includes(run.state)) throw new Error(`Product fixture Run ended ${run.state}`);
    await sleep(100);
  }
  throw new Error('Product fixture Run did not complete before the seed deadline');
}
export async function seedProduct(api, providerOrigin, { turns = 40, workspace } = {}) {
  const models = await api('/api/models/read', {});
  await api('/api/models/save', { expectedRevision: models.revision, channel: { id: 'benchmark', name: 'Benchmark controlled provider', type: 'openai', enabled: true,
    baseUrl: `${providerOrigin}/v1`, authentication: { kind: 'none' }, parameters: {}, models: [{ id: 'benchmark-model', name: 'Benchmark model', enabled: true,
      protocol: 'openai-responses', operations: ['chat'], input: ['text'], contextWindow: 1048576, maxOutputTokens: 32768, reasoning: false }] } });
  const settings = await api('/api/models/settings/read', {});
  await api('/api/models/settings/update', { scope: 'global', expectedRevision: settings.globalRevision,
    set: { defaultProvider: 'benchmark', defaultModel: 'benchmark-model' }, remove: ['defaultThinkingLevel'] });
  const identity = await api('/api/threads/create', { key: 'benchmark-history-create' });
  let snapshot = await api('/api/threads/snapshot', identity);
  for (let turn = 0; turn < turns; turn++) {
    const accepted = await api('/api/threads/submit', { ...identity, key: `benchmark-history-${turn}`, text: seedPrompt(turn), expectedHead: snapshot.historyPage.head,
      model: { providerId: 'benchmark', modelId: 'benchmark-model' } });
    await awaitRun(api, accepted.run_id);
    snapshot = await api('/api/threads/snapshot', identity);
    // Inspect only synthetic content in memory. The evidence file holds counts,
    // not messages, tokens, model request bodies or credential material.
    if (!JSON.stringify(snapshot.history).includes(`Synthetic answer ${turn}.`)) throw new Error('Completed seed Run did not materialize its synthetic answer');
  }
  await api('/api/threads/update', { runtime: 'agent', threadId: identity.threadId, key: 'benchmark-title', expectedRevision: snapshot.thread.revision, title: 'Benchmark long history' });
  let source = null;
  if (workspace) {
    const resolved = await api('/api/threads/source/resolve', { ...identity, resourceOwner: { kind: 'local' }, path: workspace });
    const prepared = await api('/api/threads/source/prepare', { ...identity, key: 'benchmark-source', resourceOwner: { kind: 'local' }, workspaceId: resolved.workspaceId,
      mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [] });
    source = prepared.source;
    const accepted = await api('/api/threads/submit', { ...identity, key: 'benchmark-bind-source', text: 'Bind the synthetic benchmark workspace. Reply briefly without using tools.',
      expectedHead: snapshot.historyPage.head, model: { providerId: 'benchmark', modelId: 'benchmark-model' }, source });
    await awaitRun(api, accepted.run_id);
    snapshot = await api('/api/threads/snapshot', identity);
  }
  return { identity, source, turns, completedTurns: turns, head: snapshot.historyPage.head, provider: 'controlled-local-sse', provenance: 'production-host-api-and-rust-owner' };
}
