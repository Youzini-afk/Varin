import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { SCRIPT_CAPABILITY } from '@varin/extension-builtins';
import { createExtensionTools, retainExtensionTool } from './extension-tool-owner.js';
import { resolveScriptNodeBinding, restoreScriptNodeBinding, scriptNodeSpawnInput } from './script-node-binding.js';
import { createScriptRuntime } from './script-runtime.js';
import { withToolInvocation } from './tool-invocation.js';
import type { KernelClient } from './kernel-client.js';
import type { LaunchSource, NodeBinding } from './protocol.generated.js';

const installation = vi.hoisted(() => ({ worker: '' }));
// Only installed-package lookup changes between releases. Real paths, byte hashes,
// Catalog extension artifacts, composition restoration and the evaluator are real.
vi.mock('@varin/extension-builtins/host', async importOriginal => {
  const actual = await importOriginal<typeof import('@varin/extension-builtins/host')>();
  return { ...actual, resolveVarinBuiltinPackageRoot: (value: string) =>
    value.replaceAll('\\', '/').endsWith('/script-runtime/dist/worker.js') && installation.worker
      ? installation.worker : actual.resolveVarinBuiltinPackageRoot(value) };
});
const roots: string[] = [];
afterEach(async () => {
  installation.worker = '';
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
async function releases(hoisted = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-script-recovery-')); roots.push(root);
  let packageRoot = path.join(repository, 'packages/script-runtime');
  if (hoisted) {
    const installed = path.join(root, 'source/packages/script-runtime');
    await fs.cp(path.join(packageRoot, 'dist'), path.join(installed, 'dist'), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(installed, 'package.json'));
    await fs.mkdir(path.join(installed, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(root, 'source/node_modules'), { recursive: true });
    const acornRoot = path.dirname(createRequire(path.join(packageRoot, 'package.json')).resolve('acorn/package.json'));
    await fs.symlink(acornRoot, path.join(root, 'source/node_modules/acorn'), 'junction');
    packageRoot = installed;
  }
  // Preserve the installed evaluator's real runtime dependency, even when the
  // package manager hoists it above this package's own node_modules directory.
  const acornRoot = await fs.realpath(path.dirname(createRequire(path.join(packageRoot, 'package.json')).resolve('acorn/package.json')));
  for (const release of ['original', 'current']) {
    const target = path.join(root, release);
    await fs.cp(path.join(packageRoot, 'dist'), path.join(target, 'dist'), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(target, 'package.json'));
    await fs.mkdir(path.join(target, 'node_modules'), { recursive: true });
    await fs.symlink(acornRoot, path.join(target, 'node_modules/acorn'), 'junction');
  }
  installation.worker = path.join(root, 'original/dist/worker.js');
  const original = await resolveScriptNodeBinding();
  installation.worker = path.join(root, 'current/dist/worker.js');
  return { root, original };
}

it.each([false, true])('restores the exact retained worker, rejects changed originals, and executes its actual Node entry point (hoisted=%s)', async hoisted => {
  const { root, original } = await releases(hoisted);
  const current = await resolveScriptNodeBinding();
  expect(current.worker_identity).toBe(original.worker_identity);
  expect(current.configuration_identity).not.toBe(original.configuration_identity);
  // The current release need not retain the same evaluator bytes.
  await fs.appendFile(current.worker_path, '\n// New distribution.\n');
  expect((await resolveScriptNodeBinding()).worker_identity).not.toBe(original.worker_identity);
  const restored = await restoreScriptNodeBinding(original.configuration_identity);
  expect(restored).toEqual(original);
  const input = scriptNodeSpawnInput(restored);
  const child = spawn(input.command, input.args, { stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(input.env!.map(entry => [entry.name, entry.value])) });
  const closed = once(child, 'close');
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const lines = createInterface({ input: child.stdout });
  const frames = lines[Symbol.asyncIterator]();
  const next = async () => {
    const frame = await frames.next();
    if (frame.done) {
      const [code, signal] = await closed;
      throw new Error(`Script worker closed before its next protocol frame (exit=${code}, signal=${signal}). ${stderr || 'No stderr.'}`);
    }
    return JSON.parse(frame.value);
  };
  try {
    child.stdin.write(JSON.stringify({ v: 2, environmentId: 'original', type: 'initialize', bindingIdentity: restored.configuration_identity }) + '\n');
    expect(await next()).toMatchObject({ type: 'ready', bindingIdentity: original.configuration_identity });
    child.stdin.write(JSON.stringify({ v: 2, environmentId: 'original', type: 'eval', cellId: 'new-cell',
      script: 'print(process.argv[1]); await Promise.resolve(42)' }) + '\n');
    expect(await next()).toMatchObject({ type: 'output', part: { kind: 'text', text: original.worker_path } });
    expect(await next()).toMatchObject({ type: 'completed', cellId: 'new-cell', valueText: '42' });
    child.stdin.end(); expect(await closed).toEqual([0, null]); expect(stderr).toBe('');
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await closed; }
  const saved = JSON.parse(original.configuration_identity);
  for (const value of [undefined, null, '{}', '{bad', JSON.stringify({ ...saved, executable: process.execPath + '.other' }),
    JSON.stringify({ ...saved, nodeVersion: '0.0.0' }), JSON.stringify({ ...saved, replAwait: false }),
    JSON.stringify({ ...saved, worker: 'relative/worker.js' }),
    JSON.stringify({ ...saved, worker: path.dirname(saved.worker) + path.sep + '..' + path.sep + 'dist' + path.sep + 'worker.js' }),
    JSON.stringify({ ...saved, worker: path.join(root, 'missing/worker.js') })]) {
    await expect(restoreScriptNodeBinding(value)).rejects.toThrow('Original script Node binding is unavailable');
  }
  const bytes = await fs.readFile(original.worker_path);
  await fs.appendFile(original.worker_path, '\n// Changed original.\n');
  await expect(restoreScriptNodeBinding(original.configuration_identity)).rejects.toThrow('Original script Node binding is unavailable');
  await fs.writeFile(original.worker_path, bytes);
  expect(await restoreScriptNodeBinding(original.configuration_identity)).toEqual(original);
  await fs.rm(original.worker_path);
  await expect(restoreScriptNodeBinding(original.configuration_identity)).rejects.toThrow('Original script Node binding is unavailable');
});

it('cold-restores a real saved script service without replay, and rechecks the original before process admission', async () => {
  const { root, original } = await releases();
  const source: LaunchSource = { resource_owner: { kind: 'local' }, workspace_id: 'workspace', execution_workspace_id: 'workspace',
    mode: 'materialized', branch_id: 'branch', revision: 1, live_root: null };
  const invocationOwner = { extensionId: 'varin.builtin.scripts', extensionVersion: '1.0.0', entrypointId: 'host' as const, instanceKey: 'test', generation: 1 };
  const processAdmissions: NodeBinding[] = [];
  const kernel = { agentRuntimeRequest: async (method: string, params: { node: NodeBinding }) => {
    if (method !== 'runtime.managed_process.begin') throw new Error('Unexpected dispatch');
    processAdmissions.push(params.node);
  } } as unknown as KernelClient;
  const scripts = createScriptRuntime({ kernel, runtime: { onEvent: () => () => {}, onReady: () => () => {}, launch: async () => null,
    managedSource: async () => ({ scriptBinding: resolveScriptNodeBinding }) } as never,
    resolveLiveSource: async () => {}, onError: error => { throw error; } });
  let host: ApplicationExtensionRuntime | undefined;
  const scopes: Awaited<ReturnType<ReturnType<typeof createExtensionTools>>>[] = [];
  async function startHost() {
    const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.44',
      brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
    runtime.capabilities.register(SCRIPT_CAPABILITY, () => { throw new Error('Restoration must not replay a tool'); });
    await runtime.start(); return runtime;
  }
  const currentPolicy = async () => ({ mode: 'normal' as const, rules: [] });
  const fallback = Object.assign(() => null, { enabled: (descriptor: { id: string }) => descriptor.id === 'varin.script.close' });
  try {
    host = await startHost(); installation.worker = original.worker_path;
    const selected = await host.prepareService({ serviceId: 'varin.script.close', version: 1, method: 'execute', args: [], routing: { threadId: 'thread' } });
    const lease = await retainExtensionTool({ runtime: host, kernel, currentPolicy,
      configurationIdentity: await scripts.prepareConfiguration(fallback, source) }, selected);
    const saved = structuredClone(lease.binding); lease.lease.release();
    await host.stop(); host = await startHost(); installation.worker = path.join(root, 'current/dist/worker.js');
    await fs.appendFile(installation.worker, '\n// New release.\n');
    const preparer = createExtensionTools({ runtime: host, kernel, currentPolicy,
      prepareConfiguration: (run, required) => scripts.prepareConfiguration(fallback, run.source, required) });
    const run = { runId: 'original-run', threadId: 'thread', branchId: 'history', source };
    const restored = await preparer(run, [saved], new AbortController().signal); scopes.push(restored);
    expect(restored.initial.map(value => value.binding)).toEqual([saved]);
    expect(processAdmissions).toEqual([]);
    const fresh = await preparer({ ...run, runId: 'fresh-run' }, [], new AbortController().signal); scopes.push(fresh);
    expect(fresh.initial[0]!.binding.configurationIdentity).toBe((await resolveScriptNodeBinding()).configuration_identity);
    // Original configuration passed during discovery cannot authorize unrelated providers.
    const untrusted = await scripts.prepareConfiguration(fallback, source, [{ ...saved, extensionId: 'other.extension' }]);
    expect(() => untrusted(selected.descriptor, saved.configurationIdentity)).toThrow('Original script Node binding is unavailable');
    const remote = await scripts.prepareConfiguration(fallback, { ...source,
      resource_owner: { kind: 'managed_host', hostId: 'target', connectionId: 'connection', endpointIdentity: 'target-endpoint' } }, [saved]);
    expect(() => remote(selected.descriptor, saved.configurationIdentity)).toThrow('Original script Node binding is unavailable');
    const invokeOpen = () => withToolInvocation({ owner: invocationOwner, signal: new AbortController().signal, authority: {
      invocationId: 'open', operationId: 'request:tool:open', callId: 'open', runId: 'original-run', threadId: 'thread',
      executorOwner: { kind: 'kernel' }, origin: { kind: 'model_step', request_id: 'request' }, source,
      toolName: 'script_open', operation: 'effect', completion: 'job', configurationIdentity: saved.configurationIdentity, arguments: {},
    } }, async invocation => scripts.capability('open', {}, { owner: invocationOwner, signal: new AbortController().signal, invocation }));
    // Missing physical launch deliberately stops after the actual Node admission seam.
    expect(await invokeOpen()).toEqual({ error: 'Script environment requires the original physical source' });
    expect(processAdmissions).toEqual([original]);
    await fs.appendFile(original.worker_path, '\n// Altered after preparation.\n');
    expect(await invokeOpen()).toEqual({ error: 'Original script Node binding is unavailable' });
    expect(processAdmissions).toEqual([original]);
    await fs.rm(path.join(root, 'original'), { recursive: true });
    // A new automatic root discovers today's configured directory after the old release is removed.
    // Neither an accepted original nor a delegated child's exact binding gets this rebind.
    const automatic = await preparer({ ...run, runId: 'automatic-root' }, [], new AbortController().signal);
    scopes.push(automatic);
    expect(automatic.initial.map(value => value.binding.serviceId)).toEqual([saved.serviceId]);
    expect(automatic.initial[0]!.binding.configurationIdentity).toBe((await resolveScriptNodeBinding()).configuration_identity);
    for (const fixed of [false, true]) await expect(preparer({ ...run, runId: `original-${fixed}`, fixed, restoreExact: true },
      [saved], new AbortController().signal)).rejects.toThrow(`extension_tool_configuration_unavailable:${saved.serviceId}`);
    expect(processAdmissions).toEqual([original]);
  } finally {
    for (const scope of scopes) { scope.close(); for (const retained of scope.initial) retained.lease.release(); }
    await scripts.dispose(); await host?.stop();
  }
});
