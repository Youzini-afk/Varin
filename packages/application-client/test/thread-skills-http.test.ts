import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createThreadsHttpAPI } from '../src/threads-http.js';

const identity = { runtime: 'agent' as const, threadId: 'thread:skills', branchId: 'branch:skills' };
const text = '正文 /skill:review';
const skills = [{ resourceId: 'selected-resource', version: 'captured-version', start: 3, end: text.length }];

it('keeps raw skill ranges through every real input HTTP path and reads the actual branch catalog', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return Response.json({});
  };
  try {
    const api = createThreadsHttpAPI();
    await api.submit({ ...identity, key: 'submit', text, skills, expectedHead: null, model: { providerId: 'fixture', modelId: 'model' } });
    await api.enqueue({ ...identity, key: 'queue', text, skills, mode: 'boundary' });
    await api.collaboration!.continueChild({ ...identity, key: 'continue', text, skills, previousRunId: 'old-run', expectedHead: 'old-head' });
    await api.editInput('queued-input', 3, text, undefined, skills);
    for (const call of calls) assert.deepEqual((call.body as { skills: unknown; text: string }).skills, skills);
    for (const call of calls) assert.equal((call.body as { text: string }).text, text);
    assert.deepEqual(calls.map(call => call.path), ['/api/threads/submit', '/api/threads/enqueue', '/api/threads/child/continue', '/api/threads/input/edit']);
    const controller = new AbortController();
    await api.resources.skills(identity, {}, controller.signal);
    assert.deepEqual(calls.at(-1), { path: '/api/threads/resources/skills', body: identity, signal: controller.signal });
    await api.resources.draftSkills({}, controller.signal);
    assert.deepEqual(calls.at(-1), { path: '/api/threads/resources/draft-skills', body: {}, signal: controller.signal });
    const source = { resourceOwner: { kind: 'managed_host' as const, hostId: 'target', connectionId: 'connection', endpointIdentity: 'endpoint' }, path: '/target/project' };
    await api.resources.draftSkills({ source }, controller.signal);
    assert.deepEqual(calls.at(-1), { path: '/api/threads/resources/draft-skills', body: { source }, signal: controller.signal });
  } finally { globalThis.fetch = original; }
});

it('does not publish late skill candidates after the caller cancels the source query', async () => {
  const original = globalThis.fetch;
  let finish!: (value: unknown) => void;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  try {
    const controller = new AbortController();
    const pending = createThreadsHttpAPI().resources.skills(identity, {}, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    finish({ snapshotId: 'obsolete', skills: [] });
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
