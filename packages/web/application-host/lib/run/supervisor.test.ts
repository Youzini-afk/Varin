import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createDebugSupervisor } from './debug-supervisor.js';
import { createTestSupervisor } from './test-supervisor.js';
import { createWorkspaceTaskRunner } from './tasks.js';
import { createRunRuntime } from './runtime.js';
import {
  createWorkspaceDebugCapabilityHandler,
  createWorkspaceTasksCapabilityHandler,
  createWorkspaceTestCapabilityHandler,
} from './capability.js';
import { registerRunRoutes } from './routes.js';
import {
  VARIN_DAP_FIXTURE_ADAPTER_ARGS,
  VARIN_TEST_FIXTURE_PROVIDER_ARGS,
} from './servers.js';
import type {
  DebugAdapterDescriptor,
  VarinTestEvent,
  TestProviderDescriptor,
} from './types.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <Value>(
  probe: () => Value | Promise<Value>,
  timeoutMs = 12000,
): Promise<Exclude<Value, false | 0 | '' | null | undefined>> => {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value as Exclude<Value, false | 0 | '' | null | undefined>;
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw lastError ?? new Error('Timed out waiting for run supervisor condition');
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const requireReady = <Value extends { status: string }>(
  value: Value,
): Extract<Value, { status: 'ready' }> => {
  expect(value.status).toBe('ready');
  if (value.status !== 'ready') throw new Error(`Expected ready result, received ${value.status}`);
  return value as Extract<Value, { status: 'ready' }>;
};

const fixtureAdapter = (overrides: Partial<DebugAdapterDescriptor> = {}): DebugAdapterDescriptor => ({
  adapterId: overrides.adapterId ?? 'fixture',
  command: process.execPath,
  args: VARIN_DAP_FIXTURE_ADAPTER_ARGS,
  languageIds: overrides.languageIds ?? ['javascript'],
  source: overrides.source ?? 'host',
  ...(overrides.env ? { env: overrides.env } : {}),
});

const fixtureTests = (overrides: Partial<TestProviderDescriptor> = {}): TestProviderDescriptor => ({
  providerId: overrides.providerId ?? 'fixture-tests',
  command: process.execPath,
  args: VARIN_TEST_FIXTURE_PROVIDER_ARGS,
  source: overrides.source ?? 'host',
  ...(overrides.env ? { env: overrides.env } : {}),
});

describe('debug supervisor', () => {
  it('runs a fixture DAP session with breakpoints, stack, variables, and evaluate', async () => {
    const harness = await createDocumentAuthorityHarness();
    const debug = createDebugSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      debug.registerAdapter(fixtureAdapter());
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'app.js'), 'const value = 1;\n');
      const preconfigured = debug.setBreakpoints({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'app.js',
        lines: [1],
        expectedSessionId: null,
        expectedGeneration: null,
      });
      expect(preconfigured).toMatchObject({
        status: 'ready',
        workspaceId: harness.identity.workspaceId,
        breakpoints: [{ resourceId: 'app.js', line: 1 }],
      });
      expect(preconfigured).not.toHaveProperty('sessionId');
      const started = await debug.start({
        workspaceId: harness.identity.workspaceId,
        program: 'app.js',
        languageId: 'javascript',
      });
      expect(started.status === 'paused' || started.status === 'running').toBe(true);
      const paused = await waitUntil(() => {
        const status = debug.getStatus(harness.identity.workspaceId);
        return status.status === 'paused' ? status : null;
      });
      if (!paused.sessionId || typeof paused.generation !== 'number') {
        throw new Error('Paused debug session is missing its owner identity');
      }
      expect(paused.generation).toBeGreaterThan(0);
      const staleBreakpoints = debug.setBreakpoints({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'app.js',
        lines: [2],
        expectedSessionId: 'replaced-session',
        expectedGeneration: paused.generation,
      });
      expect(staleBreakpoints).toEqual({
        status: 'stale',
        workspaceId: harness.identity.workspaceId,
        sessionId: paused.sessionId,
        generation: paused.generation,
        breakpoints: [{ resourceId: 'app.js', line: 1 }],
      });
      expect(debug.setBreakpoints({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'app.js',
        lines: [3],
        expectedSessionId: paused.sessionId,
        expectedGeneration: paused.generation + 1,
      })).toEqual({
        status: 'stale',
        workspaceId: harness.identity.workspaceId,
        sessionId: paused.sessionId,
        generation: paused.generation,
        breakpoints: [{ resourceId: 'app.js', line: 1 }],
      });
      expect(debug.setBreakpoints({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'app.js',
        lines: [4],
        expectedSessionId: null,
        expectedGeneration: null,
      })).toEqual({
        status: 'stale',
        workspaceId: harness.identity.workspaceId,
        sessionId: paused.sessionId,
        generation: paused.generation,
        breakpoints: [{ resourceId: 'app.js', line: 1 }],
      });
      const acceptedBreakpoints = debug.setBreakpoints({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'app.js',
        lines: [2],
        expectedSessionId: paused.sessionId,
        expectedGeneration: paused.generation,
      });
      expect(acceptedBreakpoints).toMatchObject({
        status: 'ready',
        sessionId: paused.sessionId,
        generation: paused.generation,
        breakpoints: [{ resourceId: 'app.js', line: 2 }],
      });
      const threads = await debug.getThreads({ workspaceId: harness.identity.workspaceId });
      expect(threads).toMatchObject({ status: 'ready', value: [{ id: 1, name: 'fixture' }] });
      const stack = requireReady(await debug.getStack({ workspaceId: harness.identity.workspaceId, threadId: 1 }));
      expect(stack.value[0]).toMatchObject({ name: 'fixtureMain', line: 2 });
      const scopes = requireReady(await debug.getScopes({ workspaceId: harness.identity.workspaceId, frameId: 1 }));
      const firstScope = scopes.value[0];
      if (!firstScope) throw new Error('Expected the fixture debug scope');
      expect(firstScope.variablesReference).toBeGreaterThan(0);
      const variables = requireReady(await debug.getVariables({
        workspaceId: harness.identity.workspaceId,
        variablesReference: firstScope.variablesReference,
      }));
      expect(variables.value).toEqual([
        expect.objectContaining({ name: 'value', value: '1' }),
      ]);
      const evaluated = requireReady(await debug.evaluate({
        workspaceId: harness.identity.workspaceId,
        expression: '1 + 1',
        frameId: 1,
      }));
      expect(evaluated.value).toBe('1 + 1');
      await debug.continue({ workspaceId: harness.identity.workspaceId });
      await waitUntil(() => debug.getStatus(harness.identity.workspaceId).status === 'stopped');
    } finally {
      await debug.dispose();
      await harness.cleanup();
    }
  });

  it('isolates a crashed adapter and recovers after unregister', async () => {
    const harness = await createDocumentAuthorityHarness();
    const debug = createDebugSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      debug.registerAdapter(fixtureAdapter({
        adapterId: 'crash',
        env: { VARIN_DAP_FIXTURE_CRASH: '1' },
      }));
      const crashed = await debug.start({
        workspaceId: harness.identity.workspaceId,
        program: 'app.js',
      });
      expect(['failed', 'stopped']).toContain(crashed.status);
      await debug.unregisterAdapter('crash');
      debug.registerAdapter(fixtureAdapter({ adapterId: 'healthy' }));
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'app.js'), 'const value = 1;\n');
      const started = await debug.start({
        workspaceId: harness.identity.workspaceId,
        program: 'app.js',
      });
      expect(['paused', 'running', 'starting']).toContain(started.status);
      await waitUntil(() => debug.getStatus(harness.identity.workspaceId).status === 'paused');
    } finally {
      await debug.dispose();
      await harness.cleanup();
    }
  });

  it('refuses project-provided adapters in untrusted workspaces without spawning', async () => {
    const harness = await createDocumentAuthorityHarness();
    let spawned = 0;
    const debug = createDebugSupervisor({
      documents: harness.authority,
      spawn: (...args) => {
        spawned += 1;
        return spawn(...args);
      },
      isTrusted: async () => false,
    });
    try {
      debug.registerAdapter(fixtureAdapter({ source: 'workspace' }));
      const result = await debug.start({
        workspaceId: harness.identity.workspaceId,
        program: 'app.js',
      });
      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/Untrusted workspace/i);
      expect(spawned).toBe(0);
    } finally {
      await debug.dispose();
      await harness.cleanup();
    }
  });

  it('stops the previous debug owner when the workspace is disposed', async () => {
    const harness = await createDocumentAuthorityHarness();
    const debug = createDebugSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      debug.registerAdapter(fixtureAdapter());
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'app.js'), 'const value = 1;\n');
      await debug.start({
        workspaceId: harness.identity.workspaceId,
        program: 'app.js',
      });
      await waitUntil(() => debug.getStatus(harness.identity.workspaceId).status === 'paused');
      await debug.disposeWorkspace(harness.identity.workspaceId);
      expect(debug.getStatus(harness.identity.workspaceId).status).toBe('absent');
    } finally {
      await debug.dispose();
      await harness.cleanup();
    }
  });
});

describe('task runner and tests', () => {
  it('runs a Node task from varin.tasks.json only for a trusted workspace', async () => {
    const harness = await createDocumentAuthorityHarness();
    const tasks = createWorkspaceTaskRunner({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'hello.js'),
        'console.log("hello-task");\n',
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'varin.tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [{ id: 'hello', label: 'Hello', type: 'node', script: 'hello.js' }],
        }),
      );
      const listed = await tasks.list(harness.identity.workspaceId);
      expect(listed).toMatchObject({
        status: 'ready',
        configurations: [expect.objectContaining({ id: 'hello', type: 'node' })],
      });
      const output: string[] = [];
      tasks.subscribe(harness.identity.workspaceId, (event) => {
        if (event.kind === 'output') output.push(event.text);
      });
      const started = await tasks.run({
        workspaceId: harness.identity.workspaceId,
        taskId: 'hello',
      });
      expect(started.status).toBe('running');
      await waitUntil(() => tasks.cancel({ workspaceId: harness.identity.workspaceId, runId: 'missing' })
        && output.join('').includes('hello-task')
        ? true
        : started.runId && output.join('').includes('hello-task'));
      await waitUntil(() => output.join('').includes('hello-task'));
    } finally {
      await tasks.dispose();
      await harness.cleanup();
    }
  });

  it('discovers and runs Node tests, and isolates a crashed test provider', async () => {
    const harness = await createDocumentAuthorityHarness();
    const tests = createTestSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'hello.test.js'),
        'const test = require("node:test");\nconst assert = require("node:assert/strict");\ntest("adds", () => assert.equal(1 + 1, 2));\n',
      );
      tests.registerProvider({
        providerId: 'varin.node-test',
        kind: 'node-test',
        source: 'builtin',
      });
      const discovered = await tests.discover({ workspaceId: harness.identity.workspaceId });
      expect(discovered.status).toBe('ready');
      expect(discovered.tests.some((item) => item.resourceId === 'hello.test.js')).toBe(true);
      const events: VarinTestEvent[] = [];
      tests.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      await tests.run({ workspaceId: harness.identity.workspaceId });
      await waitUntil(() => events.some((event) => (
        event.kind === 'test' && event.test.status === 'passed'
      )));
      const ownerEvent = events.find((event) => event.kind === 'status' && event.snapshot.status === 'running');
      const owner = ownerEvent?.kind === 'status' ? ownerEvent.snapshot : undefined;
      const passed = events.find((event) => event.kind === 'test' && event.test.status === 'passed');
      if (!owner) throw new Error('Expected a running test owner');
      expect(passed).toMatchObject({ runId: owner.runId, generation: owner.generation });
      tests.registerProvider(fixtureTests({
        providerId: 'crash',
        env: { VARIN_TEST_FIXTURE_CRASH: '1' },
      }));
      const crashed = await tests.run({
        workspaceId: harness.identity.workspaceId,
        providerId: 'crash',
      });
      expect(['failed', 'stopped']).toContain(crashed.status);
      const recovered = await tests.discover({ workspaceId: harness.identity.workspaceId });
      expect(recovered.status).toBe('ready');
    } finally {
      await tests.dispose();
      await harness.cleanup();
    }
  });

  it('runs Node debug, task, and test on one workspace', async () => {
    const harness = await createDocumentAuthorityHarness();
    const runtime = createRunRuntime({
      documents: harness.authority,
      spawn,
      pathModule: path,
      env: process.env,
      isTrusted: async () => true,
      registerBuiltins: true,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'debuggee.js'),
        'const value = 41;\nconst next = value + 1;\nconsole.log(next);\n',
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'hello.test.js'),
        'const test = require("node:test");\nconst assert = require("node:assert/strict");\ntest("adds", () => assert.equal(1 + 1, 2));\n',
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'varin.tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [{ id: 'debuggee', label: 'Debuggee', type: 'node', script: 'debuggee.js' }],
        }),
      );
      const listed = await runtime.tasks.list(harness.identity.workspaceId);
      expect(listed.status).toBe('ready');
      const taskOutput: string[] = [];
      runtime.tasks.subscribe(harness.identity.workspaceId, (event) => {
        if (event.kind === 'output') taskOutput.push(event.text);
      });
      await runtime.tasks.run({
        workspaceId: harness.identity.workspaceId,
        taskId: 'debuggee',
      });
      await waitUntil(() => taskOutput.join('').includes('42'));
      const discovered = await runtime.tests.discover({ workspaceId: harness.identity.workspaceId });
      expect(discovered.tests.some((item) => item.resourceId === 'hello.test.js')).toBe(true);
      const testEvents: VarinTestEvent[] = [];
      runtime.tests.subscribe(harness.identity.workspaceId, (event) => testEvents.push(event));
      await runtime.tests.run({ workspaceId: harness.identity.workspaceId });
      await waitUntil(() => testEvents.some((event) => event.kind === 'test' && event.test.status === 'passed'));
      runtime.debug.setBreakpoints({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'debuggee.js',
        lines: [3],
        expectedSessionId: null,
        expectedGeneration: null,
      });
      const started = await runtime.debug.start({
        workspaceId: harness.identity.workspaceId,
        program: 'debuggee.js',
        languageId: 'javascript',
      });
      expect(['paused', 'running', 'starting']).toContain(started.status);
      await waitUntil(() => (
        runtime.debug.getStatus(harness.identity.workspaceId).status === 'paused'
      ));
      const stack = requireReady(await runtime.debug.getStack({
        workspaceId: harness.identity.workspaceId,
        threadId: 1,
      }));
      expect(stack.value.length).toBeGreaterThan(0);
      await runtime.debug.continue({ workspaceId: harness.identity.workspaceId });
    } finally {
      await runtime.dispose();
      await harness.cleanup();
    }
  });
});

describe('workspace run capabilities', () => {
  it('exposes status and rejects unknown methods without an HTTP adapter registry', async () => {
    const harness = await createDocumentAuthorityHarness();
    const runtime = createRunRuntime({
      documents: harness.authority,
      spawn: () => {
        throw new Error('run capability tests must not spawn');
      },
      isTrusted: async () => false,
      registerBuiltins: false,
    });
    try {
      const debugCall = createWorkspaceDebugCapabilityHandler(runtime.debug);
      const taskCall = createWorkspaceTasksCapabilityHandler(runtime.tasks);
      const testCall = createWorkspaceTestCapabilityHandler(runtime.tests);
      expect(asRecord(await debugCall('getStatus', { workspaceId: harness.identity.workspaceId })).status).toBe('absent');
      expect(asRecord(await taskCall('list', { workspaceId: harness.identity.workspaceId })).status).toBe('ready');
      expect(asRecord(await testCall('getStatus', { workspaceId: harness.identity.workspaceId })).status).toBe('absent');
      expect(await debugCall('setBreakpoints', {
        workspaceId: harness.identity.workspaceId,
        resourceId: 'src/file.js',
        lines: [4],
        expectedSessionId: 'missing',
        expectedGeneration: 1,
      })).toEqual({
        status: 'stale',
        workspaceId: harness.identity.workspaceId,
        breakpoints: [],
      });
      await expect(debugCall('spawn', {})).rejects.toThrow(/does not implement spawn/);
      await expect(taskCall('spawn', {})).rejects.toThrow(/does not implement spawn/);
      await expect(testCall('spawn', {})).rejects.toThrow(/does not implement spawn/);

      const ownerA = { extensionId: 'dev.example.a', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'run-provider-a-fixture', generation: 1 };
      const ownerB = { extensionId: 'dev.example.b', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'run-provider-b-fixture', generation: 1 };
      await debugCall('registerAdapter', { adapterId: 'shared', command: 'adapter-a', source: 'builtin' }, { owner: ownerA });
      await expect(debugCall('registerAdapter', { adapterId: 'shared', command: 'adapter-b' }, { owner: ownerB }))
        .rejects.toThrow(/already owned/);
      expect(await debugCall('unregisterAdapter', { adapterId: 'shared' }, { owner: ownerB }))
        .toMatchObject({ status: 'not-owned' });
      expect(await debugCall('unregisterAdapter', { adapterId: 'shared' }, { owner: ownerA }))
        .toMatchObject({ status: 'unregistered' });
      await testCall('registerProvider', { providerId: 'shared', command: 'tests-a', source: 'builtin' }, { owner: ownerA });
      await expect(testCall('registerProvider', { providerId: 'shared', command: 'tests-b' }, { owner: ownerB }))
        .rejects.toThrow(/already owned/);
      expect(await testCall('unregisterProvider', { providerId: 'shared' }, { owner: ownerB }))
        .toMatchObject({ status: 'not-owned' });
      expect(await testCall('unregisterProvider', { providerId: 'shared' }, { owner: ownerA }))
        .toMatchObject({ status: 'unregistered' });

      const app = express();
      app.use(express.json());
      registerRunRoutes(app, runtime);
      const preconfigured = await request(app).post('/api/debug/breakpoints').send({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'src/file.js',
        lines: [4],
        expectedSessionId: null,
        expectedGeneration: null,
      });
      expect(preconfigured.body).toMatchObject({
        status: 'ready',
        breakpoints: [{ resourceId: 'src/file.js', line: 4 }],
      });
      const staleMutation = await request(app).post('/api/debug/breakpoints').send({
        workspaceId: harness.identity.workspaceId,
        resourceId: 'src/file.js',
        lines: [8],
        expectedSessionId: 'missing',
        expectedGeneration: 1,
      });
      expect(staleMutation.body).toEqual({
        status: 'stale',
        workspaceId: harness.identity.workspaceId,
        breakpoints: [{ resourceId: 'src/file.js', line: 4 }],
      });
      const missingDebug = await request(app).post('/api/debug/adapters').send({ command: 'evil' });
      const missingTests = await request(app).post('/api/tests/providers').send({ command: 'evil' });
      expect(missingDebug.status).toBeGreaterThanOrEqual(400);
      expect(missingTests.status).toBeGreaterThanOrEqual(400);
    } finally {
      await runtime.dispose();
      await harness.cleanup();
    }
  });
});
