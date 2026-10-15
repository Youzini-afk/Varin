import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { threadCommand } from './commands-thread.js';
import { scheduleCommand } from './commands-schedule.js';
import { modelsCommand } from './commands-models.js';
import { parseArgs } from './cli-args.js';
const identity = { runtime: 'agent', threadId: 'thread:created', branchId: 'branch:main' };
const receipt = { thread_id: identity.threadId, branch_id: identity.branchId, input_id: 'input:original', run_id: 'run:original', cursor: 2 };
const options = { explicitPort: true, port: 44444, json: true };
let calls: Array<{ path: string; body: Record<string, unknown> }>;
let output: string;
beforeEach(() => { calls = []; output = ''; vi.spyOn(process.stdout, 'write').mockImplementation(value => { output += String(value); return true; }); vi.spyOn(process.stderr, 'write').mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());
function install(handler: (path: string, body: Record<string, unknown>) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body }); return new Response(JSON.stringify(handler(path, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());
describe('native CLI requests', () => {
  test('parser carries native identity and exact retry head', () => {
    const parsed = parseArgs(['thread', 'send', '--thread', 'thread:a', '--branch', 'branch:b', '--key', 'retry', '--expected-head', 'null']);
    expect(parsed.threadAction).toBe('send'); expect(parsed.options).toMatchObject({ thread: 'thread:a', branch: 'branch:b', key: 'retry', expectedHead: 'null' });
  });
  test('create retries retain empty expected head and original input receipt; wait follows its Run', async () => {
    let reads = 0;
    install((path) => {
      if (path.endsWith('/create')) return identity;
      if (path.endsWith('/snapshot')) return { identity, historyPage: { head: 'later-head', previous: null }, history: [] };
      if (path.endsWith('/submit')) return receipt;
      if (path.endsWith('/run')) return { id: receipt.run_id, state: ++reads > 1 ? 'completed' : 'waiting' };
      throw new Error(`Unexpected endpoint ${path}`);
    });
    await threadCommand({ ...options, key: 'same', prompt: 'hello', model: 'provider/model', wait: true }, 'create');
    await threadCommand({ ...options, key: 'same', prompt: 'hello', model: 'provider/model' }, 'create');
    const submits = calls.filter(call => call.path.endsWith('/submit'));
    expect(submits).toHaveLength(2); expect(submits[0].body).toEqual(submits[1].body);
    expect(submits[0].body).toMatchObject({ ...identity, key: 'same:input', expectedHead: null, text: 'hello', model: { providerId: 'provider', modelId: 'model' } });
    expect(calls.filter(call => call.path.endsWith('/run')).every(call => call.body.runId === receipt.run_id)).toBe(true);
    expect(output).toContain('run:original'); expect(calls.some(call => call.path.includes('/varin/runtime'))).toBe(false);
  });
  test('explicit existing-Thread retry refuses a newly sampled head', async () => {
    await expect(threadCommand({ ...options, key: 'same', thread: 'thread:a', branch: 'branch:b', prompt: 'hello', model: 'provider/model' }, 'send')).rejects.toThrow('original --expected-head');
    expect(calls).toHaveLength(0);
  });
  test('schedule rerun sends same original key and returns the full native occurrence', async () => {
    const occurrence = { id: 'occurrence:one', threadId: 'thread:scheduled', branchId: 'branch:scheduled', status: 'accepted', revision: 1 };
    install((path, body) => { expect(path).toBe('/api/projects/p/scheduled-tasks/t/run'); expect(body).toEqual({ key: 'once' }); return { task: { id: 't' }, occurrence }; });
    await scheduleCommand({ ...options, project: 'p', task: 't', key: 'once' }, 'run');
    await scheduleCommand({ ...options, project: 'p', task: 't', key: 'once' }, 'run');
    expect(calls).toHaveLength(2); expect(output).toContain('occurrence:one'); expect(output).toContain('branch:scheduled'); expect(output).not.toContain('sessionId');
  });
  test('model enumeration reads the native configured catalog, including array responses', async () => {
    install(path => { expect(path).toBe('/api/threads/models'); return [{ providerId: 'p', modelId: 'm' }]; });
    await modelsCommand(options); expect(JSON.parse(output).availableModels).toEqual([{ providerId: 'p', modelId: 'm' }]);
  });
  test('fork retries submit at the original fork cut even after its branch advances', async () => {
    install(path => {
      if (path.endsWith('/snapshot')) return { historyPage: { head: 'later-head' }, history: [] };
      if (path.endsWith('/fork')) return identity;
      if (path.endsWith('/submit')) return receipt;
      throw new Error(path);
    });
    const retry = { ...options, key: 'same-fork', thread: 'thread:original', branch: 'branch:original', message: 'history:cut', prompt: 'continue', model: 'p/m' };
    await threadCommand(retry, 'fork');
    await threadCommand(retry, 'fork');
    expect(calls.filter(call => call.path.endsWith('/fork')).map(call => call.body.headId)).toEqual(['history:cut', 'history:cut']);
    const submits = calls.filter(call => call.path.endsWith('/submit'));
    expect(submits[0].body.expectedHead).toBe('history:cut');
    expect(submits[0].body).toEqual(submits[1].body);
  });

  test('schedule creation emits the native calendar target and execution contract', async () => {
    install((path, body) => {
      expect(path).toBe('/api/projects/p/scheduled-tasks');
      expect(body.task).toEqual({ runtime: 'agent', name: 'Review', enabled: true, schedule: { kind: 'daily', times: ['09:00'] },
        execution: { prompt: 'Review work' }, target: { kind: 'new_work', model: { providerId: 'p', modelId: 'm', thinkingLevel: 'high' },
          source: { kind: 'project' }, sourceMode: 'fixed_branch', goal: { budget: { maxOutputTokens: 2000 } } } });
      return { task: { id: 'task' }, created: true };
    });
    await scheduleCommand({ ...options, project: 'p', name: 'Review', prompt: 'Review work', model: 'p/m', thinking: 'high', daily: '09:00', goal: true, goalTokenBudget: '2000' }, 'create');
  });

});
