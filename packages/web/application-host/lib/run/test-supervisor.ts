import { resolveNodeRuntime, nodeProcessEnvironment } from '@varin/protocol/node/runtime';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJsonRpcClient } from '../lsp/jsonrpc.js';
import { walkWorkspaceTestFiles } from './walk.js';
import type { ManagedProcessHandle } from "../process/types.js";
import { launchOwnedProcess, terminateOwnedProcess, managedExitConfirmed, waitForManagedExit, type ManagedProcessOwner } from "../process/types.js";
import type { DocumentAuthority, MutationOwner } from '../documents/authority.js';
import type {
  ExtensionRunOwner,
  InspectedRunWorkspace,
  VarinTestDiscoverResult,
  VarinTestEvent,
  VarinTestItem,
  VarinTestRunStatus,
  ProcessWriter,
  ProviderProcess,
  RegisteredTestProvider,
  TestProviderDescriptor,
  TestRunRecord,
  TestSupervisorOptions,
} from './types.js';

type MessageRecord = Record<string, unknown>;
type TestRunEventPayload =
  | { kind: 'test'; test: VarinTestItem }
  | { channel: string; kind: 'output'; text: string }
  | { kind: 'finished'; results?: VarinTestItem[] };

const asRecord = (value: unknown): MessageRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as MessageRecord
    : {}
);

const ownerScopeKey = (owner?: ExtensionRunOwner) => owner
  ? `${owner.extensionId}\0${owner.entrypointId}`
  : 'varin.host';
const exactOwnerKey = (owner?: ExtensionRunOwner) => owner
  ? `${ownerScopeKey(owner)}\0${owner.generation}`
  : 'varin.host\0host';


const registerProcessWriter = async (
  documents: DocumentAuthority,
  scopeId: string,
  owner: MutationOwner,
  purpose: string,
): Promise<ProcessWriter | null> => {
  return documents.registerWriterForScope(scopeId, owner, { mode: 'process', purpose });
};

const releaseProcessWriter = async (writer: ProcessWriter | null, mutated = true): Promise<void> => {
  if (!writer) return;
  if (mutated) await writer.markMutated();
  await writer.close();
};

const parseTap = (text: string, resourceId: string): VarinTestItem[] => {
  const results: VarinTestItem[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const ok = /^ok\s+\d+\s+-?\s*(.*)$/.exec(line);
    const notOk = /^not ok\s+\d+\s+-?\s*(.*)$/.exec(line);
    if (ok) {
      results.push({
        id: `${resourceId}:${results.length + 1}`,
        label: ok[1]?.trim() || resourceId,
        resourceId,
        status: 'passed',
      });
    } else if (notOk) {
      results.push({
        id: `${resourceId}:${results.length + 1}`,
        label: notOk[1]?.trim() || resourceId,
        resourceId,
        status: 'failed',
        message: notOk[1]?.trim() || 'Test failed',
      });
    }
  }
  return results;
};

const workspaceIdOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'workspaceId' in value && typeof value.workspaceId === 'string') return value.workspaceId;
  return '';
};

export const createTestSupervisor = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
  execPath = resolveNodeRuntime({ env }).executable,
  fsPromises = fs.promises,
}: TestSupervisorOptions) => {
  const providers: RegisteredTestProvider[] = [];
  const sessions = new Map<string, TestRunRecord>();
  const trees = new Map<string, VarinTestItem[]>();
  const workspaceListeners = new Map<string, Set<(event: VarinTestEvent) => void>>();
  const pendingExits = new Set<Promise<void>>();
  const generations = new Map<string, number>();
  const discoveryGenerations = new Map<string, number>();
  const discoveryProcesses = new Map<ManagedProcessOwner, { workspaceId: string; writer: ProcessWriter | null }>();

  const acquireWriter = (scopeId: string, owner: MutationOwner, purpose: string): Promise<ProcessWriter | null> => {
    return registerProcessWriter(documents, scopeId, owner, purpose);
  };

  const releaseRecordWriter = async (record: TestRunRecord, mutated = true): Promise<void> => {
    if (!record?.writer || record.writerReleased) return;
    if (record.writerRelease) return record.writerRelease;
    const writer = record.writer;
    const release = releaseProcessWriter(writer, mutated).then(() => {
      record.writerReleased = true;
      if (record.writer === writer) record.writer = null;
    }).finally(() => { delete record.writerRelease; });
    record.writerRelease = release;
    return release;
  };

  const nextGeneration = (workspaceId: string): number => {
    const next = (generations.get(workspaceId) ?? 0) + 1;
    generations.set(workspaceId, next);
    return next;
  };

  const emit = (workspaceId: string, event: VarinTestEvent): void => {
    const listeners = workspaceListeners.get(workspaceId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  };

  const snapshotFor = (record: TestRunRecord): VarinTestRunStatus => {
    const snapshot: VarinTestRunStatus = {
      status: record.status,
      workspaceId: record.workspaceId,
      runId: record.runId,
      generation: record.generation,
    };
    if (record.providerId) snapshot.providerId = record.providerId;
    if (record.message) snapshot.message = record.message;
    return snapshot;
  };

  const emitRunEvent = (
    record: TestRunRecord,
    event: TestRunEventPayload,
  ): void => emit(record.workspaceId, {
    ...event,
    runId: record.runId,
    generation: record.generation,
  });

  const findProvider = (workspaceId: string, providerId?: unknown): RegisteredTestProvider | null => {
    if (providerId) return providers.find((item) => item.providerId === providerId) ?? null;
    return providers.find((item) => (
      item.source === 'builtin' && (!item.workspaceId || item.workspaceId === workspaceId)
    )) ?? providers.find((item) => !item.workspaceId || item.workspaceId === workspaceId) ?? null;
  };

  const disposeChild = (record: TestRunRecord | null | undefined): Promise<void> => {
    if (!record) return Promise.resolve();
    record.cancelled = true;
    if (record.pendingTermination) return record.pendingTermination;
    record.rpc?.rejectAll(new Error('Test process stopped'));
    record.rpc?.dispose();
    record.rpc = null;
    const exited = terminateOwnedProcess(record).then(async () => {
      await releaseRecordWriter(record);
      if (record.status !== 'failed') record.status = 'stopped';
      emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    }).finally(() => {
      if (record.pendingTermination === exited) record.pendingTermination = null;
      pendingExits.delete(exited);
    });
    void exited.catch((error: unknown) => {
      record.status = 'failed'; record.message = error instanceof Error ? error.message : String(error);
      emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    });
    pendingExits.add(exited);
    record.pendingTermination = exited;
    return exited;
  };

  const discoverBuiltin = async (workspace: InspectedRunWorkspace): Promise<VarinTestItem[]> => {
    const files = await walkWorkspaceTestFiles({
      root: workspace.root,
      fsPromises,
      pathModule,
    });
    return files.map((resourceId) => ({
      id: resourceId,
      label: resourceId,
      resourceId,
    }));
  };

  const startProviderProcess = async (provider: RegisteredTestProvider, workspace: InspectedRunWorkspace, {
    owner,
    purpose = 'test-provider-process',
    canSpawn = () => true,
    lifecycle,
  }: {
    lifecycle?: TestRunRecord;
    canSpawn?: () => boolean;
    owner: MutationOwner;
    purpose?: string;
  }): Promise<ProviderProcess> => {
    const processOwner: ManagedProcessOwner = lifecycle ?? { child: null };
    const discovery = { workspaceId: workspace.workspaceId, writer: null as ProcessWriter | null };
    if (!lifecycle) discoveryProcesses.set(processOwner, discovery);
    let writer = await acquireWriter(workspace.workspaceId, owner, purpose);
    if (lifecycle) { lifecycle.writer = writer; lifecycle.writerReleased = false; }
    else discovery.writer = writer;
    let child: ManagedProcessHandle | null = null;
    let rpc: ReturnType<typeof createJsonRpcClient> | null = null;
    try {
      if (!canSpawn()) {
        await releaseProcessWriter(writer, false);
        writer = null;
        throw Object.assign(new Error('Test run was cancelled'), { code: 'cancelled' as const });
      }
      child = await launchOwnedProcess(processOwner, (signal) => spawn(provider.command, provider.args ?? [], {
        cwd: workspace.root,
        env: nodeProcessEnvironment(provider.command, { ...env, ...provider.env }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      }));
      if (!canSpawn()) throw new Error('Test provider startup was cancelled');
      if (!child.stdout || !child.stdin) {
        throw new Error('Test provider did not expose protocol streams');
      }
      // Stream failure rejects this protocol owner. It must never escape as an
      // uncaught Host exception, nor be mistaken for a native exit receipt.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.on('error', (error: Error) => { rpc?.rejectAll(error); });
      }
      child.on('error', (error: Error) => { rpc?.rejectAll(error); });
      rpc = createJsonRpcClient({ input: child.stdout, output: child.stdin });
      const processChild = child;
      const processRpc = rpc;
      processChild.stderr?.on('data', () => {});
      const exited = new Promise<never>((_, reject) => {
        processChild.once('exit', (code) => {
          processRpc.rejectAll(new Error('Test provider exited'));
          reject(new Error(`Test provider exited${code === null ? '' : ` with code ${code}`}`));
        });
      });
      exited.catch(() => {});
      await Promise.race([
        (async () => {
          await processRpc.request('initialize', {});
          processRpc.notify('initialized', {});
          await new Promise((resolve) => setTimeout(resolve, 30));
        })(),
        exited,
      ]);
      if (!canSpawn()) throw new Error('Test provider startup was cancelled');
      return { child: processChild, rpc: processRpc, writer, owner: processOwner };
    } catch (error) {
      rpc?.dispose();
      await terminateOwnedProcess(processOwner);
      if (lifecycle) await releaseRecordWriter(lifecycle, Boolean(child));
      else { await releaseProcessWriter(writer, Boolean(child)); discoveryProcesses.delete(processOwner); }
      throw error;
    }
  };

  const discover = async (
    request: { providerId?: unknown; workspaceId?: unknown } | string,
  ): Promise<VarinTestDiscoverResult> => {
    const workspaceId = typeof request === 'string'
      ? request
      : (typeof request.workspaceId === 'string' ? request.workspaceId : '');
    const discoveryGeneration = (discoveryGenerations.get(workspaceId) ?? 0) + 1;
    discoveryGenerations.set(workspaceId, discoveryGeneration);
    const provider = findProvider(workspaceId, typeof request === 'object' ? request.providerId : undefined);
    if (!provider) {
      return { status: 'absent', workspaceId, tests: [] };
    }
    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
        tests: [],
      };
    }
    if (provider.source === 'workspace' && !await isTrusted(workspace.root)) {
      return {
        status: 'failure',
        workspaceId,
        message: 'Untrusted workspace cannot execute project-provided test providers',
        tests: [],
      };
    }
    if (provider.kind === 'node-test') {
      const tests = await discoverBuiltin(workspace);
      if (discoveryGenerations.get(workspaceId) !== discoveryGeneration) {
        return { status: 'cancelled', workspaceId, tests: [] };
      }
      trees.set(workspaceId, tests);
      return { status: tests.length > 0 ? 'ready' : 'empty', workspaceId, tests };
    }
    let processPair;
    try {
      processPair = await startProviderProcess(provider, workspace, {
        owner: {
          kind: 'test-provider',
          id: provider.providerId,
          generation: discoveryGeneration,
        },
        purpose: 'test-provider-discovery',
        canSpawn: () => discoveryGenerations.get(workspaceId) === discoveryGeneration && providers.includes(provider),
      });
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Failed to start test provider',
        tests: [],
      };
    }
    try {
      if (!providers.includes(provider)) {
        return {
          status: 'failure',
          workspaceId,
          message: 'Test provider changed during discovery',
          tests: [],
        };
      }
      const raw = asRecord(await processPair.rpc.request('discover', {}));
      const tests: VarinTestItem[] = Array.isArray(raw.tests) ? raw.tests.map((item) => {
        const value = asRecord(item);
        const mapped: VarinTestItem = {
          id: typeof value.id === 'string' ? value.id : '',
          label: typeof value.label === 'string' ? value.label : '',
        };
        if (typeof value.resourceId === 'string') mapped.resourceId = value.resourceId;
        if (typeof value.line === 'number' && Number.isFinite(value.line)) mapped.line = value.line;
        return mapped;
      }).filter((item) => item.id) : [];
      if (discoveryGenerations.get(workspaceId) !== discoveryGeneration) {
        return { status: 'cancelled', workspaceId, tests: [] };
      }
      trees.set(workspaceId, tests);
      return { status: tests.length > 0 ? 'ready' : 'empty', workspaceId, tests };
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Test discovery failed',
        tests: [],
      };
    } finally {
      try {
        processPair.rpc.notify('shutdown', {});
      } catch {
        // Ignore.
      }
      processPair.rpc.dispose();
      try {
        processPair.child.kill();
      } catch {
        // Ignore.
      }
      await terminateOwnedProcess(processPair.owner);
      await releaseProcessWriter(processPair.writer);
      discoveryProcesses.delete(processPair.owner);
    }
  };

  const runNodeTests = async (
    record: TestRunRecord,
    workspace: InspectedRunWorkspace,
    testIds: string[],
  ): Promise<VarinTestRunStatus> => {
    const discovered = trees.get(record.workspaceId) ?? await discoverBuiltin(workspace);
    trees.set(record.workspaceId, discovered);
    const selected = testIds.length > 0
      ? discovered.filter((item) => testIds.includes(item.id) || (item.resourceId ? testIds.includes(item.resourceId) : false))
      : discovered;
    const results: VarinTestItem[] = [];
    for (const item of selected) {
      if (record.cancelled || sessions.get(record.workspaceId) !== record) return snapshotFor(record);
      if (!item.resourceId) continue;
      const resourceId = item.resourceId;
      emitRunEvent(record, { kind: 'test', test: { ...item, status: 'running' } });
      const filePath = pathModule.join(workspace.root, resourceId);
      const chunks: string[] = [];
      let child: ManagedProcessHandle | null = null;
      let spawned = false;
      const writer = await acquireWriter(record.workspaceId, {
        kind: 'test',
        id: record.runId,
        generation: record.generation,
      }, 'test-process');
      record.writer = writer; record.writerReleased = false;
      try {
        if (record.cancelled || sessions.get(record.workspaceId) !== record) {
          await releaseRecordWriter(record, false);
          return snapshotFor(record);
        }
        child = await launchOwnedProcess(record, (signal) => spawn(execPath, ['--test', '--test-reporter=tap', filePath], {
          cwd: workspace.root,
          env: nodeProcessEnvironment(execPath, { ...env, NODE_OPTIONS: '' }),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal,
        }));
        spawned = true;
        record.child = child;
        const processChild = child;
        processChild.stdout?.on('data', (chunk) => {
          chunks.push(chunk.toString('utf8'));
          emitRunEvent(record, { kind: 'output', channel: 'test', text: chunk.toString('utf8') });
        });
        processChild.stderr?.on('data', (chunk) => {
          emitRunEvent(record, { kind: 'output', channel: 'test', text: chunk.toString('utf8') });
        });
        processChild.stdout?.setEncoding('utf8'); processChild.stderr?.setEncoding('utf8');
        await waitForManagedExit(processChild);
        const code = processChild.exitCode;
        if (!record.child || record.child.exitConfirmed || typeof record.child.exitCode === "number" || record.child.signalCode) record.child = null;
        if (record.cancelled || sessions.get(record.workspaceId) !== record) return snapshotFor(record);
        const parsed = parseTap(chunks.join(''), resourceId);
        if (parsed.length === 0) {
          const fallback: VarinTestItem = {
            ...item,
            status: code === 0 ? 'passed' : 'failed',
            ...(code === 0 ? {} : { message: `Test process exited with code ${code}` }),
          };
          results.push(fallback);
          emitRunEvent(record, { kind: 'test', test: fallback });
        } else {
          for (const result of parsed) {
            results.push(result);
            emitRunEvent(record, { kind: 'test', test: result });
          }
        }
      } finally {
        if (managedExitConfirmed(record.child)) {
          if (record.child === child) record.child = null;
          await releaseRecordWriter(record, spawned);
        }
      }
    }
    if (record.cancelled || sessions.get(record.workspaceId) !== record) return snapshotFor(record);
    record.status = results.some((item) => item.status === 'failed') ? 'failed' : 'stopped';
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    emitRunEvent(record, { kind: 'finished', results });
    return snapshotFor(record);
  };

  const runProvider = async (
    record: TestRunRecord,
    provider: RegisteredTestProvider,
    workspace: InspectedRunWorkspace,
    testIds: string[],
  ): Promise<VarinTestRunStatus> => {
    const processPair = await startProviderProcess(provider, workspace, {
      owner: {
        kind: 'test',
        id: record.runId,
        generation: record.generation,
      },
      lifecycle: record,
      purpose: 'test-provider-process',
      canSpawn: () => !record.cancelled && sessions.get(record.workspaceId) === record,
    });
    record.child = processPair.child;
    record.rpc = processPair.rpc;
    record.writer = processPair.writer;
    if (sessions.get(record.workspaceId) !== record || !providers.includes(provider)) {
      disposeChild(record);
      record.status = 'stopped';
      record.message = 'Test provider changed during startup';
      return snapshotFor(record);
    }
    processPair.child.on('exit', (code) => {
      if (record.child !== processPair.child) return;
      if (!record.child || record.child.exitConfirmed || typeof record.child.exitCode === "number" || record.child.signalCode) record.child = null;
      record.rpc = null;
      void releaseRecordWriter(record).catch((error: unknown) => {
        record.status = 'failed'; record.message = error instanceof Error ? error.message : String(error);
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      });
      if (record.status === 'running') {
        record.status = 'failed';
        record.message = `Test provider exited${code === null ? '' : ` with code ${code}`}`;
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
    });
    processPair.rpc.onNotification((method, params) => {
      if (
        record.cancelled
        || sessions.get(record.workspaceId) !== record
        || record.child !== processPair.child
        || record.rpc !== processPair.rpc
      ) return;
      const notification = asRecord(params);
      if (method === 'test/started' && typeof notification.id === 'string') {
        emitRunEvent(record, { kind: 'test', test: { id: notification.id, label: typeof notification.label === 'string' ? notification.label : notification.id, status: 'running' } });
      }
      if (method === 'test/passed' && typeof notification.id === 'string') {
        emitRunEvent(record, { kind: 'test', test: { id: notification.id, label: typeof notification.label === 'string' ? notification.label : notification.id, status: 'passed' } });
      }
      if (method === 'test/failed' && typeof notification.id === 'string') {
        const test: VarinTestItem = {
          id: notification.id,
          label: typeof notification.label === 'string' ? notification.label : notification.id,
          status: 'failed',
        };
        if (typeof notification.resourceId === 'string') test.resourceId = notification.resourceId;
        if (typeof notification.line === 'number' && Number.isFinite(notification.line)) test.line = notification.line;
        if (typeof notification.message === 'string') test.message = notification.message;
        if (typeof notification.stack === 'string') test.stack = notification.stack;
        emitRunEvent(record, { kind: 'test', test });
      }
      if (method === 'test/finished') {
        record.status = notification.status === 'failed' ? 'failed' : 'stopped';
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        emitRunEvent(record, { kind: 'finished' });
      }
    });
    await processPair.rpc.request('run', { testIds });
    return snapshotFor(record);
  };

  const run = async (
    request: { providerId?: unknown; testIds?: unknown; workspaceId?: unknown },
  ): Promise<VarinTestRunStatus> => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const provider = findProvider(workspaceId, request?.providerId);
    if (!provider) return { status: 'absent', workspaceId };
    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return {
        status: 'failed',
        workspaceId,
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
      };
    }
    if (!await isTrusted(workspace.root)) {
      return {
        status: 'failed',
        workspaceId,
        message: 'Untrusted workspace cannot run tests',
      };
    }
    const existing = sessions.get(workspaceId);
    if (existing) {
      await disposeChild(existing);
      if (sessions.get(workspaceId) === existing) sessions.delete(workspaceId);
    }
    const record: TestRunRecord = {
      workspaceId,
      runId: randomUUID(),
      providerId: provider.providerId,
      providerOwnerKey: provider.ownerKey,
      generation: nextGeneration(workspaceId),
      status: 'running',
      message: '',
      child: null,
      rpc: null,
      writer: null,
      writerReleased: false,
      pendingTermination: null,
      cancelled: false,
    };
    sessions.set(workspaceId, record);
    emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    const testIds = Array.isArray(request?.testIds) ? request.testIds.filter((id): id is string => typeof id === 'string') : [];
    try {
      if (provider.kind === 'node-test') return await runNodeTests(record, workspace, testIds);
      return await runProvider(record, provider, workspace, testIds);
    } catch (error) {
      record.status = 'failed';
      record.message = error instanceof Error ? error.message : 'Test run failed';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      disposeChild(record);
      return snapshotFor(record);
    }
  };

  return {
    registerProvider(descriptor: TestProviderDescriptor, owner?: ExtensionRunOwner) {
      if (!descriptor?.providerId) throw new Error('Test provider requires providerId');
      const next: RegisteredTestProvider = {
        providerId: descriptor.providerId,
        kind: descriptor.kind === 'node-test' ? 'node-test' : 'adapter',
        command: typeof descriptor.command === 'string' ? descriptor.command : '',
        args: Array.isArray(descriptor.args) ? descriptor.args : [],
        source: owner
          ? 'extension'
          : (descriptor.source === 'workspace' || descriptor.source === 'extension' || descriptor.source === 'builtin'
            ? descriptor.source
            : 'host'),
        ownerScopeKey: ownerScopeKey(owner),
        ownerKey: exactOwnerKey(owner),
      };
      if (typeof descriptor.workspaceId === 'string' && descriptor.workspaceId) {
        next.workspaceId = descriptor.workspaceId;
      }
      if (descriptor.env && typeof descriptor.env === 'object') next.env = descriptor.env;
      if (next.kind === 'adapter' && !next.command) {
        throw new Error('Test provider requires command');
      }
      const existingIndex = providers.findIndex((provider) => provider.providerId === next.providerId);
      const existing = existingIndex >= 0 ? providers[existingIndex] : null;
      if (existing && existing.ownerScopeKey !== next.ownerScopeKey) {
        throw new Error(`Test provider ID is already owned: ${next.providerId}`);
      }
      if (existingIndex >= 0) providers.splice(existingIndex, 1, next);
      else providers.push(next);
      if (existing) {
        for (const [workspaceId, record] of sessions) {
          if (record.providerId !== existing.providerId) continue;
          void disposeChild(record).then(() => {
            if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
          }).catch(() => undefined);
          trees.delete(workspaceId);
        }
      }
      return { status: 'registered', providerId: next.providerId };
    },
    async unregisterProvider(providerId: string, owner?: ExtensionRunOwner) {
      const index = providers.findIndex((item) => (
        item.providerId === providerId && item.ownerKey === exactOwnerKey(owner)
      ));
      if (index < 0) return { status: 'not-owned', providerId };
      providers.splice(index, 1);
      for (const [workspaceId, record] of sessions) {
        if (record.providerId !== providerId) continue;
        await disposeChild(record);
        record.message = 'Test provider disabled';
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        sessions.delete(workspaceId);
        trees.delete(workspaceId);
      }
      await Promise.all([...pendingExits]);
      return { status: 'unregistered', providerId };
    },
    discover,
    run,
    cancel(request: unknown): VarinTestRunStatus {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (!record) return { status: 'absent', workspaceId };
      disposeChild(record);
      record.message = 'Test run cancelled; waiting for process exit';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      return snapshotFor(record);
    },
    getStatus(request: unknown): VarinTestRunStatus {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (record) return snapshotFor(record);
      const tests = trees.get(workspaceId);
      if (tests) return { status: tests.length > 0 ? 'idle' : 'empty', workspaceId };
      return { status: 'absent', workspaceId };
    },
    subscribe(workspaceId: string, listener: (event: VarinTestEvent) => void) {
      const listeners = workspaceListeners.get(workspaceId) ?? new Set();
      listeners.add(listener);
      workspaceListeners.set(workspaceId, listeners);
      return {
        close() {
          listeners.delete(listener);
          if (listeners.size === 0) workspaceListeners.delete(workspaceId);
        },
      };
    },
    async disposeWorkspace(request: unknown): Promise<void> {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (record) {
        await disposeChild(record);
        if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
      }
      discoveryGenerations.delete(workspaceId);
      await Promise.all([...discoveryProcesses].filter(([, state]) => state.workspaceId === workspaceId).map(async ([owner, state]) => {
        await terminateOwnedProcess(owner); await releaseProcessWriter(state.writer); discoveryProcesses.delete(owner);
      }));
      trees.delete(workspaceId);
      workspaceListeners.delete(workspaceId);
      await Promise.all([...pendingExits]);
    },
    async dispose(): Promise<void> {
      await Promise.all([...sessions.values()].map((record) => disposeChild(record)));
      await Promise.all([...discoveryProcesses].map(async ([owner, state]) => {
        await terminateOwnedProcess(owner); await releaseProcessWriter(state.writer); discoveryProcesses.delete(owner);
      }));
      sessions.clear();
      providers.length = 0;
      trees.clear();
      discoveryGenerations.clear();
      workspaceListeners.clear();
      await Promise.all([...pendingExits]);
    },
  };
};
