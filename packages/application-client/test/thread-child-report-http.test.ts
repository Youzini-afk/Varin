import "./network-fixture.js";
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ChildReportPage } from '@varin/protocol';
import { createThreadsHttpAPI } from '../src/threads-http.js';

const identity = { runtime: 'agent' as const, threadId: 'parent', branchId: 'parent-branch' };
const page: ChildReportPage = { format: 'output_body', operation_id: 'original-dispatch', execution_id: 'original-execution', item_id: 'original-report',
  offset: 12, next_offset: 32, total_bytes: 55, text: 'original page bytes' };

it('reads original dispatch and execution report pages through the actual HTTP client without choosing their format', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return Response.json(page);
  };
  try {
    const api = createThreadsHttpAPI().collaboration!; const controller = new AbortController();
    assert.deepEqual(await api.readReport(identity, 'original-dispatch', 'original-report', 12, 20, controller.signal), page);
    assert.deepEqual(await api.readExecutionReport(identity, 'original-execution', 'original-report', 12, 20, controller.signal), page);
    assert.deepEqual(calls, [
      { path: '/api/threads/child/report', body: { ...identity, operationId: 'original-dispatch', itemId: 'original-report', offset: 12, maxBytes: 20 }, signal: controller.signal },
      { path: '/api/threads/child/execution/report', body: { ...identity, executionId: 'original-execution', itemId: 'original-report', offset: 12, maxBytes: 20 }, signal: controller.signal },
    ]);
  } finally { globalThis.fetch = original; }
});

it('rejects a late original dispatch report after cancellation rather than publishing old report bytes', async () => {
  const original = globalThis.fetch; let finish!: (value: unknown) => void;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  try {
    const controller = new AbortController();
    const pending = createThreadsHttpAPI().collaboration!.readReport(identity, 'original-dispatch', 'original-report', 0, undefined, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); finish(page);
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
