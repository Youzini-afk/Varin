import { spawn, type SpawnOptionsWithStdioTuple, type StdioPipe } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from './supervisor.js';
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from './servers.js';

const launchProcess = (command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>) => spawn(command, args, options);

it('prepares on demand and shares startup between concurrent requests', async () => {
  const harness = await createDocumentAuthorityHarness();
  const prepare = vi.fn(async () => ({ command: process.execPath, args: VARIN_LSP_FIXTURE_SERVER_ARGS }));
  const launch = vi.fn(launchProcess);
  const supervisor = createLanguageSupervisor({ documents: harness.authority, spawn: launch, prepareProvider: prepare });
  supervisor.registerProvider({ providerId: 'managed', command: 'not-installed', languageIds: ['go'], source: 'builtin' });
  try {
    supervisor.getStatus(harness.identity.workspaceId, 'go');
    expect(prepare).not.toHaveBeenCalled();
    const request = { resource: harness.resource('main.go'), languageId: 'go', content: 'package main\n', documentVersion: 1, reason: 'open' };
    const results = await Promise.all([supervisor.syncDocument(request), supervisor.syncDocument(request)]);
    expect(results.map((result) => result.status)).toEqual(['synced', 'synced']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  } finally { await supervisor.dispose(); await harness.cleanup(); }
});

it('disposing a workspace aborts preparation before any language process can start', async () => {
  const harness = await createDocumentAuthorityHarness();
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const launch = vi.fn(launchProcess);
  let preparationSignal: AbortSignal | undefined;
  const supervisor = createLanguageSupervisor({
    documents: harness.authority, spawn: launch,
    prepareProvider: async (_provider, _root, signal) => {
      preparationSignal = signal;
      markEntered();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return null;
    },
  });
  supervisor.registerProvider({ providerId: 'managed', command: 'not-installed', languageIds: ['go'], source: 'builtin' });
  try {
    const request = supervisor.syncDocument({ resource: harness.resource('main.go'), languageId: 'go', content: 'package main\n', documentVersion: 1, reason: 'open' });
    await entered;
    await supervisor.disposeWorkspace(harness.identity.workspaceId);
    await request;
    expect(preparationSignal?.aborted).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(supervisor.getStatus(harness.identity.workspaceId, 'go').status).toBe('absent');
  } finally { await supervisor.dispose(); await harness.cleanup(); }
});
