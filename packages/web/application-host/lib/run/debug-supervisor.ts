import { nodeProcessEnvironment } from '@varin/protocol/node/runtime';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createDapClient } from './dap.js';
import { resolveWorkspacePath } from '../workspace/path-safety.js';
import type { ManagedProcessHandle } from "../process/types.js";
import { launchOwnedProcess, terminateOwnedProcess, managedExitConfirmed } from "../process/types.js";
import type { DocumentAuthority, MutationOwner } from '../documents/authority.js';
import type {
  DebugAdapterDescriptor,
  DebugBreakpointMutationRequest,
  DebugRequest,
  DebugSessionRecord,
  DebugStartRequest,
  ExtensionRunOwner,
  VarinBreakpoint,
  VarinDebugBreakpointListResult,
  VarinDebugBreakpointsResult,
  VarinDebugEvent,
  VarinDebugFeatureResult,
  VarinDebugScope,
  VarinDebugSessionStatus,
  VarinDebugStackFrame,
  VarinDebugThread,
  VarinDebugVariable,
  ProcessWriter,
  RegisteredDebugAdapter,
  RunPathModule,
  RunSupervisorOptions,
} from './types.js';

type MessageRecord = Record<string, unknown>;

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

const relativeFromRoot = (root: string, absolutePath: string, pathModule: RunPathModule): string | null => {
  const relative = pathModule.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) return null;
  return relative.split(pathModule.sep).join('/');
};

const resourceIdFromSource = (source: unknown, root: string, pathModule: RunPathModule): string => {
  const record = asRecord(source);
  const raw = typeof record.path === 'string' ? record.path : typeof source === 'string' ? source : '';
  if (!raw) return '';
  if (!pathModule.isAbsolute(raw) && !raw.startsWith('file:')) return raw.replace(/\\/g, '/');
  try {
    const absolute = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
    return relativeFromRoot(root, absolute, pathModule) ?? '';
  } catch {
    return '';
  }
};

const workspaceIdOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'workspaceId' in value && typeof value.workspaceId === 'string') return value.workspaceId;
  return '';
};

export const createDebugSupervisor = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
}: RunSupervisorOptions) => {
  const adapters: RegisteredDebugAdapter[] = [];
  const sessions = new Map<string, DebugSessionRecord>();
  const breakpoints = new Map<string, VarinBreakpoint[]>();
  const watches = new Map<string, string[]>();
  const workspaceListeners = new Map<string, Set<(event: VarinDebugEvent) => void>>();
  const generations = new Map<string, number>();
  const pendingExits = new Set<Promise<void>>();

  const acquireWriter = (scopeId: string, owner: MutationOwner): Promise<ProcessWriter | null> => {
    return registerProcessWriter(documents, scopeId, owner, 'debug-process');
  };

  const releaseRecordWriter = async (record: DebugSessionRecord, mutated = true): Promise<void> => {
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

  const emit = (workspaceId: string, event: VarinDebugEvent): void => {
    const listeners = workspaceListeners.get(workspaceId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  };

  const snapshotFor = (record: DebugSessionRecord): VarinDebugSessionStatus => {
    const snapshot: VarinDebugSessionStatus = {
      status: record.status,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      generation: record.generation,
    };
    if (record.adapterId) snapshot.adapterId = record.adapterId;
    if (record.message) snapshot.message = record.message;
    if (record.reason) snapshot.reason = record.reason;
    return snapshot;
  };

  const findAdapter = (adapterId?: unknown, languageId?: unknown): RegisteredDebugAdapter | null => {
    if (typeof adapterId === 'string' && adapterId) return adapters.find((item) => item.adapterId === adapterId) ?? null;
    if (typeof languageId === 'string' && languageId) {
      return adapters.find((item) => item.languageIds.includes(languageId)) ?? null;
    }
    return adapters.find((item) => item.source === 'builtin') ?? adapters[0] ?? null;
  };

  const disposeRecord = (record: DebugSessionRecord | null | undefined, reason = 'Debug session stopped'): Promise<void> => {
    if (!record) return Promise.resolve();
    if (record.pendingTermination) return record.pendingTermination;
    record.rpc?.rejectAll(new Error(reason));
    record.rpc?.dispose();
    record.rpc = null;
    record.message = reason + '; waiting for process exit';
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    const exited = terminateOwnedProcess(record)
      .then(async () => {
        await releaseRecordWriter(record);
        record.status = 'stopped'; record.message = reason;
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      })
      .finally(() => {
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

  const setFailed = (record: DebugSessionRecord, message: string): void => {
    record.status = 'failed';
    record.message = message;
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
  };

  const getStatus = (request: unknown): VarinDebugSessionStatus => {
    const workspaceId = workspaceIdOf(request);
    const existing = sessions.get(workspaceId);
    if (existing) return snapshotFor(existing);
    return { status: 'absent', workspaceId };
  };

  const listBreakpoints = (request: unknown): VarinBreakpoint[] => (
    breakpoints.get(workspaceIdOf(request)) ?? []
  );

  const activeSession = (workspaceId: string): DebugSessionRecord | null => {
    const record = sessions.get(workspaceId);
    return record && (record.status === 'starting' || record.status === 'running' || record.status === 'paused')
      ? record
      : null;
  };

  function breakpointResult(workspaceId: string): VarinDebugBreakpointListResult;
  function breakpointResult(workspaceId: string, status: 'stale'): VarinDebugBreakpointsResult;
  function breakpointResult(
    workspaceId: string,
    status: 'ready' | 'stale' = 'ready',
  ): VarinDebugBreakpointsResult {
    const record = activeSession(workspaceId);
    return {
      status,
      workspaceId,
      ...(record ? { sessionId: record.sessionId, generation: record.generation } : {}),
      breakpoints: listBreakpoints(workspaceId).map((item) => ({ ...item })),
    };
  }

  const setBreakpoints = (request: DebugBreakpointMutationRequest): VarinDebugBreakpointsResult => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const resourceId = typeof request?.resourceId === 'string' ? request.resourceId : '';
    const record = activeSession(workspaceId);
    const expectsNoSession = request?.expectedSessionId === null
      && request?.expectedGeneration === null;
    const expectsSession = typeof request?.expectedSessionId === 'string'
      && request.expectedSessionId.length > 0
      && typeof request.expectedGeneration === 'number'
      && Number.isSafeInteger(request.expectedGeneration)
      && request.expectedGeneration >= 1;
    if (!expectsNoSession && !expectsSession) {
      throw new Error('Breakpoint mutation requires an observed debug owner');
    }
    const ownerChanged = expectsNoSession
      ? Boolean(record)
      : (
        !record
        || request.expectedSessionId !== record.sessionId
        || request.expectedGeneration !== record.generation
      );
    if (ownerChanged) return breakpointResult(workspaceId, 'stale');
    const lines = Array.isArray(request?.lines)
      ? [...new Set(request.lines.map((line) => Number(line)).filter((line): line is number => Number.isFinite(line) && line >= 1))].sort((a, b) => a - b)
      : [];
    const current = breakpoints.get(workspaceId) ?? [];
    const next = current.filter((item) => item.resourceId !== resourceId);
    for (const line of lines) next.push({ resourceId, line });
    next.sort((left, right) => left.resourceId.localeCompare(right.resourceId) || left.line - right.line);
    breakpoints.set(workspaceId, next);
    if (record?.rpc && (record.status === 'running' || record.status === 'paused')) {
      const program = pathModule.join(record.root, resourceId);
      void record.rpc.request('setBreakpoints', {
        source: { path: program },
        breakpoints: lines.map((line) => ({ line })),
      }).catch(() => {});
    }
    const result = breakpointResult(workspaceId);
    emit(workspaceId, { kind: 'breakpoints', snapshot: result });
    return result;
  };

  const start = async (request: DebugStartRequest): Promise<VarinDebugSessionStatus> => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const existing = sessions.get(workspaceId);
    if (existing) await disposeRecord(existing, 'Replaced by a new debug session');
    const adapter = findAdapter(request?.adapterId, request?.languageId);
    if (!adapter) {
      return { status: 'absent', workspaceId, message: 'No debug adapter is registered' };
    }
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
        adapterId: adapter.adapterId,
        message: 'Untrusted workspace cannot start debug sessions',
      };
    }
    const programId = typeof request?.program === 'string' ? request.program : '';
    let programPath = '';
    if (programId) {
      try {
        const resolved = await resolveWorkspacePath(programId, {
          root: workspace.root,
          fsPromises: fs.promises,
          pathModule,
        });
        programPath = resolved.realPath;
      } catch (error) {
        return {
          status: 'failed',
          workspaceId,
          message: error instanceof Error ? error.message : 'Debug program is outside the workspace',
        };
      }
    }
    const sessionId = randomUUID();
    const record: DebugSessionRecord = {
      workspaceId,
      sessionId,
      adapterId: adapter.adapterId,
      adapterOwnerKey: adapter.ownerKey,
      generation: nextGeneration(workspaceId),
      status: 'starting',
      message: '',
      child: null,
      rpc: null,
      writer: null,
      writerReleased: false,
      pendingTermination: null,
      root: workspace.root,
      program: programPath,
    };
    sessions.set(workspaceId, record);
    let child: ManagedProcessHandle | null = null;
    try {
      record.writer = await acquireWriter(workspaceId, {
        kind: 'debug',
        id: sessionId,
        generation: record.generation,
      });
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      child = await launchOwnedProcess(record, (signal) => spawn(adapter.command, adapter.args ?? [], {
        cwd: workspace.root,
        env: nodeProcessEnvironment(adapter.command, { ...env, ...adapter.env }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      }));
    } catch (error) {
      if (managedExitConfirmed(record.child)) await releaseRecordWriter(record, Boolean(child));
      setFailed(record, error instanceof Error ? error.message : 'Failed to start debug adapter');
      return snapshotFor(record);
    }
    record.child = child;
    if (!child.stdout || !child.stdin) {
      setFailed(record, 'Debug adapter did not expose protocol streams');
      disposeRecord(record, record.message);
      return snapshotFor(record);
    }
    const rpc = createDapClient({ input: child.stdout, output: child.stdin });
    record.rpc = rpc;
    rpc.onNotification((method, params) => {
      if (sessions.get(workspaceId) !== record || record.child !== child || record.rpc !== rpc) return;
      const notification = asRecord(params);
      if (method === 'stopped') {
        record.status = 'paused';
        if (typeof notification.reason === 'string') record.reason = notification.reason;
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        return;
      }
      if (method === 'continued' || method === 'output' || method === 'exited' || method === 'terminated') {
        if (method === 'output' && typeof notification.output === 'string') {
          emit(workspaceId, {
            kind: 'output',
            sessionId,
            channel: 'debug-console',
            text: notification.output,
          });
        }
        if (method === 'terminated' || method === 'exited') {
          record.status = 'stopped';
          emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        }
        if (method === 'continued') {
          record.status = 'running';
          delete record.reason;
          emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        }
      }
    });
    child.stderr?.on('data', () => {
      // stderr may contain paths; never log adapter payloads.
    });
    child.on("error", (error: Error) => {
      if (record.child !== child) return;
      rpc.rejectAll(error); setFailed(record, error.message);
    });
    child.on('exit', (code) => {
      if (record.child !== child) return;
      rpc.rejectAll(new Error('Debug adapter exited'));
      if (record.status === 'starting' || record.status === 'running' || record.status === 'paused') {
        setFailed(record, `Debug adapter exited${code === null ? '' : ` with code ${code}`}`);
      }
      if (!record.child || record.child.exitConfirmed || typeof record.child.exitCode === "number" || record.child.signalCode) record.child = null;
      record.rpc = null;
      void releaseRecordWriter(record).catch((error: unknown) => {
        record.status = 'failed'; record.message = error instanceof Error ? error.message : String(error);
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      });
    });
    try {
      const initialized = rpc.waitForEvent('initialized');
      const capabilities = asRecord(await rpc.request('initialize', {
        adapterID: adapter.adapterId,
        clientID: 'varin',
        clientName: 'Varin',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
      }));
      const launchParams: MessageRecord = { cwd: workspace.root };
      if (programPath) launchParams.program = programPath;
      const launch = rpc.request('launch', launchParams);
      void launch.catch(() => undefined);
      await initialized;
      const grouped = new Map<string, number[]>();
      for (const item of listBreakpoints(workspaceId)) {
        const lines = grouped.get(item.resourceId) ?? [];
        lines.push(item.line);
        grouped.set(item.resourceId, lines);
      }
      for (const [resourceId, lines] of grouped) {
        await rpc.request('setBreakpoints', {
          source: { path: pathModule.join(workspace.root, resourceId) },
          breakpoints: lines.map((line) => ({ line })),
        });
      }
      if (capabilities?.supportsConfigurationDoneRequest === true) {
        await rpc.request('configurationDone', {});
      }
      await launch;
      if (sessions.get(workspaceId) !== record || !adapters.includes(adapter)) {
        disposeRecord(record, 'Debug adapter changed during startup');
        if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
        return snapshotFor(record);
      }
      if (record.status === 'starting') record.status = 'running';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      return snapshotFor(record);
    } catch (error) {
      setFailed(record, error instanceof Error ? error.message : 'Failed to initialize debug adapter');
      disposeRecord(record, record.message);
      return snapshotFor(record);
    }
  };

  const withSessionStatus = async (
    workspaceId: string,
    action: (record: DebugSessionRecord, rpc: NonNullable<DebugSessionRecord['rpc']>) => Promise<VarinDebugSessionStatus>,
  ): Promise<VarinDebugSessionStatus> => {
    const record = sessions.get(workspaceId);
    const rpc = record?.rpc;
    if (!record || !rpc) {
      return { status: 'absent', workspaceId };
    }
    if (record.status === 'failed' || record.status === 'stopped') {
      return snapshotFor(record);
    }
    try {
      return await action(record, rpc);
    } catch (error) {
      if (record.rpc && (record.status === 'running' || record.status === 'paused')) {
        record.status = 'failed';
        record.message = error instanceof Error ? error.message : 'Debug request failed';
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return {
        status: 'failed',
        workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        message: error instanceof Error ? error.message : 'Debug request failed',
      };
    }
  };

  const withSessionFeature = async <Value>(
    workspaceId: string,
    action: (
      record: DebugSessionRecord,
      rpc: NonNullable<DebugSessionRecord['rpc']>,
    ) => Promise<VarinDebugFeatureResult<Value>>,
  ): Promise<VarinDebugFeatureResult<Value>> => {
    const record = sessions.get(workspaceId);
    const rpc = record?.rpc;
    if (!record || !rpc) return { status: 'absent', workspaceId };
    if (record.status === 'failed' || record.status === 'stopped') {
      return {
        status: 'failed',
        workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        message: record.message || 'Debug session is not active',
      };
    }
    try {
      return await action(record, rpc);
    } catch (error) {
      if (record.rpc && (record.status === 'running' || record.status === 'paused')) {
        record.status = 'failed';
        record.message = error instanceof Error ? error.message : 'Debug request failed';
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return {
        status: 'failed',
        workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        message: error instanceof Error ? error.message : 'Debug request failed',
      };
    }
  };

  const mapFrame = (frame: unknown, root: string): VarinDebugStackFrame => {
    const value = asRecord(frame);
    const mapped: VarinDebugStackFrame = {
      id: Number(value.id) || 0,
      name: typeof value.name === 'string' ? value.name : '(anonymous)',
      line: Number(value.line) || 1,
      column: Number(value.column) || 1,
    };
    const resourceId = resourceIdFromSource(value.source, root, pathModule);
    if (resourceId) mapped.resourceId = resourceId;
    return mapped;
  };

  return {
    registerAdapter(descriptor: DebugAdapterDescriptor, owner?: ExtensionRunOwner) {
      const languageIds = Array.isArray(descriptor?.languageIds)
        ? descriptor.languageIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : [];
      if (!descriptor?.adapterId || !descriptor.command) {
        throw new Error('Debug adapter requires adapterId and command');
      }
      const next: RegisteredDebugAdapter = {
        adapterId: descriptor.adapterId,
        command: descriptor.command,
        args: Array.isArray(descriptor.args) ? descriptor.args : [],
        languageIds,
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
      const existingIndex = adapters.findIndex((adapter) => adapter.adapterId === next.adapterId);
      const existing = existingIndex >= 0 ? adapters[existingIndex] : null;
      if (existing && existing.ownerScopeKey !== next.ownerScopeKey) {
        throw new Error(`Debug adapter ID is already owned: ${next.adapterId}`);
      }
      if (existingIndex >= 0) adapters.splice(existingIndex, 1, next);
      else adapters.push(next);
      if (existing) {
        for (const [workspaceId, record] of sessions) {
          if (record.adapterId !== existing.adapterId) continue;
          void disposeRecord(record, 'Debug adapter updated').then(() => {
            if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
          }).catch(() => undefined);
        }
      }
      return { status: 'registered', adapterId: next.adapterId };
    },
    async unregisterAdapter(adapterId: string, owner?: ExtensionRunOwner) {
      const index = adapters.findIndex((item) => (
        item.adapterId === adapterId && item.ownerKey === exactOwnerKey(owner)
      ));
      if (index < 0) return { status: 'not-owned', adapterId };
      adapters.splice(index, 1);
      for (const [workspaceId, record] of sessions) {
        if (record.adapterId !== adapterId) continue;
        await disposeRecord(record, 'Debug adapter disabled');
        if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
      }
      await Promise.all([...pendingExits]);
      return { status: 'unregistered', adapterId };
    },
    getStatus,
    listBreakpoints: (request: unknown): VarinDebugBreakpointListResult => breakpointResult(workspaceIdOf(request)),
    setBreakpoints,
    start,
    async stop(request: unknown): Promise<VarinDebugSessionStatus> {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (!record) return { status: 'absent', workspaceId };
      await disposeRecord(record, 'Debug session stopped');
      if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
      await Promise.all([...pendingExits]);
      return snapshotFor(record);
    },
    continue: (request: DebugRequest) => withSessionStatus(request.workspaceId, async (record, rpc) => {
      await rpc.request('continue', { threadId: 1 });
      if (record.status === 'paused' || record.status === 'starting') {
        record.status = 'running';
        delete record.reason;
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return snapshotFor(record);
    }),
    pause: (request: DebugRequest) => withSessionStatus(request.workspaceId, async (record, rpc) => {
      await rpc.request('pause', { threadId: 1 });
      return snapshotFor(record);
    }),
    stepOver: (request: DebugRequest) => withSessionStatus(request.workspaceId, async (record, rpc) => {
      await rpc.request('next', { threadId: 1 });
      return snapshotFor(record);
    }),
    stepIn: (request: DebugRequest) => withSessionStatus(request.workspaceId, async (record, rpc) => {
      await rpc.request('stepIn', { threadId: 1 });
      return snapshotFor(record);
    }),
    stepOut: (request: DebugRequest) => withSessionStatus(request.workspaceId, async (record, rpc) => {
      await rpc.request('stepOut', { threadId: 1 });
      return snapshotFor(record);
    }),
    getThreads: (request: DebugRequest) => withSessionFeature<VarinDebugThread[]>(request.workspaceId, async (record, rpc) => {
      const raw = asRecord(await rpc.request('threads', {}));
      const threads = Array.isArray(raw.threads) ? raw.threads : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: threads.map((thread) => {
          const value = asRecord(thread);
          return {
            id: Number(value.id) || 0,
            name: typeof value.name === 'string' ? value.name : 'thread',
          };
        }),
      };
    }),
    getStack: (request: DebugRequest) => withSessionFeature<VarinDebugStackFrame[]>(request.workspaceId, async (record, rpc) => {
      const raw = asRecord(await rpc.request('stackTrace', { threadId: Number(request.threadId) || 1 }));
      const frames = Array.isArray(raw.stackFrames) ? raw.stackFrames : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: frames.map((frame) => mapFrame(frame, record.root)),
      };
    }),
    getScopes: (request: DebugRequest) => withSessionFeature<VarinDebugScope[]>(request.workspaceId, async (record, rpc) => {
      const raw = asRecord(await rpc.request('scopes', { frameId: Number(request.frameId) || 1 }));
      const scopes = Array.isArray(raw.scopes) ? raw.scopes : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: scopes.map((scope) => {
          const value = asRecord(scope);
          const mapped = {
            name: typeof value.name === 'string' ? value.name : 'scope',
            variablesReference: Number(value.variablesReference) || 0,
          };
          return mapped;
        }),
      };
    }),
    getVariables: (request: DebugRequest) => withSessionFeature<VarinDebugVariable[]>(request.workspaceId, async (record, rpc) => {
      const raw = asRecord(await rpc.request('variables', {
        variablesReference: Number(request.variablesReference) || 0,
      }));
      const variables = Array.isArray(raw.variables) ? raw.variables : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: variables.map((variable) => {
          const value = asRecord(variable);
          const mapped: VarinDebugVariable = {
            name: typeof value.name === 'string' ? value.name : '',
            value: typeof value.value === 'string' ? value.value : '',
            variablesReference: Number(value.variablesReference) || 0,
          };
          if (typeof value.type === 'string') mapped.type = value.type;
          return mapped;
        }).filter((item) => item.name),
      };
    }),
    evaluate: (request: DebugRequest) => withSessionFeature<string>(request.workspaceId, async (record, rpc) => {
      const expression = typeof request.expression === 'string' ? request.expression : '';
      const raw = asRecord(await rpc.request('evaluate', {
        expression,
        frameId: Number(request.frameId) || 1,
        context: 'repl',
      }));
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: typeof raw.result === 'string' ? raw.result : 'undefined',
      };
    }),
    listWatch: (request: unknown) => {
      const workspaceId = workspaceIdOf(request);
      return {
        status: 'ready',
        workspaceId,
        expressions: watches.get(workspaceId) ?? [],
      };
    },
    addWatch(request: { expression?: unknown; workspaceId?: unknown }) {
      const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
      const expression = typeof request?.expression === 'string' ? request.expression.trim() : '';
      if (!expression) return { status: 'failed', workspaceId, message: 'Watch expression is required' };
      const current = watches.get(workspaceId) ?? [];
      if (!current.includes(expression)) current.push(expression);
      watches.set(workspaceId, current);
      return { status: 'ready', workspaceId, expressions: current };
    },
    removeWatch(request: { expression?: unknown; workspaceId?: unknown }) {
      const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
      const expression = typeof request?.expression === 'string' ? request.expression : '';
      const current = (watches.get(workspaceId) ?? []).filter((item) => item !== expression);
      watches.set(workspaceId, current);
      return { status: 'ready', workspaceId, expressions: current };
    },
    subscribe(workspaceId: string, listener: (event: VarinDebugEvent) => void) {
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
        await disposeRecord(record, 'Workspace debug session disposed');
        if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
      }
      breakpoints.delete(workspaceId);
      watches.delete(workspaceId);
      workspaceListeners.delete(workspaceId);
      await Promise.all([...pendingExits]);
    },
    async dispose(): Promise<void> {
      await Promise.all([...sessions.values()].map((record) => disposeRecord(record, 'Debug supervisor disposed')));
      sessions.clear();
      adapters.length = 0;
      breakpoints.clear();
      watches.clear();
      workspaceListeners.clear();
      await Promise.all([...pendingExits]);
    },
  };
};
