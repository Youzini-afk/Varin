import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createScheduledTasksHttpAPI, ScheduleRequestError } from '../src/schedules-http.js';

it('preserves the retired admission code and original run key without allocating or retrying', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ code: 'identity-unavailable', error: 'Earlier work may already have run.' }, { status: 409 });
  };
  try {
    const api = createScheduledTasksHttpAPI();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(api.run('project', 'task', 'original-key'), error => error instanceof ScheduleRequestError
        && error.status === 409 && error.code === 'identity-unavailable'
        && error.message === 'Earlier work may already have run.');
    }
    assert.deepEqual(calls, [0, 1].map(() => ({ path: '/api/projects/project/scheduled-tasks/task/run', body: { key: 'original-key' } })));
  } finally { globalThis.fetch = original; }
});
