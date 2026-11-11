import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createConversationOrganizationHttpAPI } from '../src/conversation-organization-http.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';
it('does not publish an organization command result decoded after switching Hosts', async () => {
  const original = globalThis.fetch;
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { if (!String(_url).includes('/api/conversation-organization/')) return new Response(null, {status:404}); signal = init?.signal; return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response; };
  try {
    const request = createConversationOrganizationHttpAPI().command({ key: 'same-intent', operation: { action: 'dissolve', id: 'group', expectedRevision: 2, parents: [] } });
    await new Promise(resolve => setImmediate(resolve));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://next-organization-host.test', runtimeKey: 'next-organization-host' });
    finish({ key: 'same-intent', revision: 9, cursor: 10, containers: [], positions: [], removed: ['group'] });
    await assert.rejects(request, /Application Host changed|abort/i);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: '' }); }
});
it('cancels the original HTTP request and rejects a late snapshot', async () => {
  const original = globalThis.fetch; let finish!: (value: unknown) => void;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  try {
    const controller = new AbortController(); const pending = createConversationOrganizationHttpAPI().read({}, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); finish({ initialized: true });
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
it('rejects a malformed snapshot rather than publishing a fabricated empty directory', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ initialized: true, revision: 3, rootRevision: 2, cursor: 1, containers: [], conversations: [{ conversation: {kind:'native',id:'x'} }], nextCursor: null });
  try { await assert.rejects(createConversationOrganizationHttpAPI().read(), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'invalid_response'); }
  finally { globalThis.fetch = original; }
});
