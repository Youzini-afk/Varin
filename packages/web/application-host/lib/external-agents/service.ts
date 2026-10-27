import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  ExternalAgentError,
  type ExternalAgentConfiguration,
  type ExternalAgentSettings,
  type ExternalConversation,
  type ExternalConversationSnapshot,
  type ExternalInput,
  type ExternalInteraction,
  type ExternalItem,
  type ExternalTurn,
  type ExternalObservation,
  type ExternalObservationChange,
} from '@varin/application-client';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { createKernelProcessService } from '../kernel/process-service.js';
import { createPlatformEnvironmentRuntime } from '../platform/environment-runtime.js';
import { HarnessTransport, record, text } from './transport.js';
import type { HarnessConnection } from './adapter.js';
import { connectCodex } from './codex.js';
import { connectPi } from './pi.js';
import { connectAcp } from './acp.js';
import { connectClaude } from './claude.js';
import type { ExternalChild } from '../kernel/protocol.generated.js';
import type { createExternalSourceOwner } from './source.js';

const defaults: ExternalAgentConfiguration[] = [
  { id: 'codex', name: 'Codex', harness: 'codex', command: 'codex', args: [], enabled: false },
  { id: 'claude', name: 'Claude Code', harness: 'claude', command: 'claude', args: [], enabled: false },
  { id: 'pi', name: 'Pi', harness: 'pi', command: 'pi', args: [], enabled: false },
];
type Spawn = ReturnType<typeof createKernelProcessService>['spawn'];
interface Live {
  launchKey: string;
  connection: HarnessConnection;
  peer: HarnessTransport;
  interactions: Map<
    string,
    {
      request: ExternalInteraction;
      resolve(value: { optionId?: string; answers?: Record<string, string[]>; text?: string }): void;
      reject(error: Error): void;
    }
  >;
}
const ended = (turn: ExternalTurn) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status);
const launchKey = (launch: Pick<ExternalAgentConfiguration, 'command' | 'args'>) =>
  JSON.stringify([launch.command, launch.args]);

export class ExternalAgentsService {
  private readonly connections = new Map<string, Live>();
  private readonly connecting = new Map<string, Promise<Live>>();
  private readonly connectionControllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly observers = new Map<string, Set<(event: ExternalObservation) => boolean>>();
  private readonly observationEpoch = randomUUID();
  private readonly structuralRevisions = new Map<string, number>();
  private readonly projectedItems = new Map<string, Map<string, ExternalItem>>();
  private readonly revisions = new Map<string, number>();
  private readonly environment = createPlatformEnvironmentRuntime();
  private stopping = false;
  private sources?: ReturnType<typeof createExternalSourceOwner>;
  private removeChildrenListener?: () => void;
  private readonly childTasks = new Map<
    string,
    { controller: AbortController; work: Promise<void>; recheck: boolean }
  >();
  private discoveringChildren = false;
  private childrenDirty = false;
  private childrenVersion = '';
  private readonly retiring = new Set<string>();
  private maintenance?: () => void;
  private cleanupWork: Promise<void> | undefined;
  private cleanupDirty = false;
  bindContentMaintenance(request: () => void) {
    this.maintenance = request;
  }
  constructor(
    private readonly deps: {
      kernel: KernelClient;
      spawn: Spawn;
      spawnAdmitted?: ReturnType<typeof createKernelProcessService>['spawnAdmitted'];
      directory: string;
      resolveWorkspace(cwd: string): Promise<{ workspaceId: string; root: string }>;
      onError?(operationId: string, error: unknown): void;
    },
  ) {}
  startChildren(sources: ReturnType<typeof createExternalSourceOwner>) {
    this.sources = sources;
    this.removeChildrenListener = this.deps.kernel.onAgentRuntimeEvent((event) => {
      // The native stream carries a durable cursor, not the individual domain event kind.
      if (event.stream === 'durable') void this.reconcileChildren();
    });
    void this.reconcileChildren();
    void this.cleanupDeleted().catch((error) => this.deps.onError?.('external-cleanup', error));
    // Accepted, not-yet-started turns are safe to resume; interrupted deliveries are not replayed.
    void this.list()
      .then((all) => {
        for (const c of all) this.advance(c.id);
      })
      .catch(() => {});
  }
  async children(activeOnly = false) {
    return this.command<ExternalChild[]>({ action: 'child_list', activeOnly });
  }
  async childPresentation(operationId: string, signal?: AbortSignal) {
    return this.command({ action: 'child_presentation', operationId }, signal);
  }
  private async reconcileChildren() {
    this.childrenDirty = true;
    if (this.discoveringChildren || this.stopping || !this.sources) return;
    this.discoveringChildren = true;
    try {
      while (this.childrenDirty && !this.stopping) {
        this.childrenDirty = false;
        const children = await this.children(true);
        const version = JSON.stringify(
          children.map((c) => [c.operation_id, c.revision, c.state, c.cancel_requested]),
        );
        if (version !== this.childrenVersion) {
          this.childrenVersion = version;
          this.notify('*');
        }
        for (const child of children) {
          if (child.report && child.resources_released && child.receipt_published) continue;
          const old = this.childTasks.get(child.operation_id);
          if (old) {
            old.recheck = true;
            if (child.cancel_requested) old.controller.abort(new Error('External delegation cancelled'));
            continue;
          }
          const controller = new AbortController();
          const task = { controller, work: Promise.resolve(), recheck: false };
          this.childTasks.set(child.operation_id, task);
          task.work = this.advanceChild(child, controller.signal)
            .catch((error) => {
              this.deps.onError?.(child.operation_id, error);
              this.notify(child.conversation_id);
            })
            .finally(() => {
              this.childTasks.delete(child.operation_id);
              if (task.recheck && !this.stopping) void this.reconcileChildren();
            });
        }
      }
    } catch (error) {
      this.deps.onError?.('external-children', error);
    } finally {
      this.discoveringChildren = false;
    }
  }
  private async advanceChild(child: ExternalChild, signal: AbortSignal) {
    const id = child.conversation_id;
    if (child.message_kind === 'inform' && !child.turn_id && !child.cancel_requested) return;
    if (child.report) {
      if (!child.resources_released && child.handoff) {
        await this.sources!.release(child, signal);
        if (!child.turn_id) await this.sources!.remove(child, true);
      }
      await this.command({ action: 'child_finish', operationId: child.operation_id, released: true });
      this.notify(id, true);
      return;
    }
    if (child.turn_id) {
      const turn = (await this.read(id)).turns.find((t) => t.id === child.turn_id);
      if (!turn) throw new Error('The original external delegated turn is unavailable');
      if (!ended(turn)) {
        if (child.cancel_requested) await this.stop(id, turn.id);
        else this.advance(id);
        return;
      }
      // The protocol ended this turn. The external conversation still owns its connection,
      // directory and retained baseline (including any legitimate background commands).
      // Release only the original preparation pin, not the conversation's working copy.
      if (child.handoff && !child.resources_released) await this.sources!.release(child, signal);
      await this.command({ action: 'child_finish', operationId: child.operation_id, released: true });
      this.notify(id);
      return;
    }
    try {
      if (child.cancel_requested) throw new Error('External delegation cancelled before input delivery');
      let source = record(child.source);
      if (!text(source.cwd)) {
        source = child.handoff
          ? await this.sources!.prepare(child, signal)
          : await (async () => {
              const cwd = path.join(
                this.deps.directory,
                'workspaces',
                createHash('sha256').update(id).digest('hex'),
              );
              await mkdir(cwd, { recursive: true });
              const workspace = await this.deps.resolveWorkspace(cwd);
              return {
                cwd,
                workspaceId: workspace.workspaceId,
                executionWorkspaceId: workspace.workspaceId,
                kind: 'private',
              };
            })();
        child = await this.command<ExternalChild>({
          action: 'child_source',
          operationId: child.operation_id,
          source,
        });
      }
      signal.throwIfAborted();
      await this.command({
        action: 'create',
        key: id,
        id,
        configurationId: child.binding.configuration_id,
        harness: child.binding.harness,
        title: child.name,
        cwd: source.cwd,
        workspaceId: source.workspaceId,
        privateWorkspace: source.kind === 'private',
        parent: {
          threadId: child.parent_thread_id,
          branchId: child.parent_branch_id,
          operationId: child.operation_id,
        },
      });
      const input = await this.command<ExternalInput>({
        action: 'child_input',
        operationId: child.operation_id,
      });
      signal.throwIfAborted();
      const turn = await this.command<ExternalTurn>({ action: 'admit', id, key: child.operation_id, input });
      await this.command({ action: 'child_link', operationId: child.operation_id, turnId: turn.id });
      this.notify(id, true);
      this.advance(id);
    } catch (error) {
      // Recover a durable admit that raced a link/observation loss before classifying failure.
      const saved = await this.read(id).catch(() => undefined);
      const admitted = saved?.turns.find((t) => t.key === child.operation_id);
      if (admitted) {
        await this.command({ action: 'child_link', operationId: child.operation_id, turnId: admitted.id });
        this.advance(id);
        return;
      }
      let cleanup: unknown;
      if (child.handoff && !child.resources_released)
        try {
          await this.sources!.release(child, new AbortController().signal);
        } catch (error) {
          cleanup = error;
        }
      if (!child.turn_id && !child.dispatch_operation_id)
        try {
          await this.sources!.remove(child, true);
        } catch (error) {
          cleanup = error;
        }
      await this.command({
        action: 'child_finish',
        operationId: child.operation_id,
        failure: `${error instanceof Error ? error.message : String(error)}${cleanup ? `; source cleanup pending: ${String(cleanup)}` : ''}`,
        released: !cleanup,
      });
      if (cleanup) throw cleanup;
      this.notify(id);
    }
  }
  private command<T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.deps.kernel.agentRuntimeRequest<T, 'runtime.external.command'>(
      'runtime.external.command',
      { command },
      signal,
    );
  }
  private notify(id: string, catalog = false, change: ExternalObservationChange = { kind: 'refresh' }) {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    const revision = this.revisions.get(id)!;
    if (change.kind === 'refresh') this.structuralRevisions.set(id, revision);
    if (catalog && id !== '*') this.revisions.set('*', (this.revisions.get('*') ?? 0) + 1);
    for (const listener of this.observers.get(id) ?? [])
      if (!listener({ ...change, epoch: this.observationEpoch, revision }))
        this.observers.get(id)?.delete(listener);
    if (catalog && id !== '*')
      for (const listener of this.observers.get('*') ?? [])
        if (!listener({ kind: 'refresh', epoch: this.observationEpoch, revision: this.revisions.get('*')! }))
          this.observers.get('*')?.delete(listener);
  }
  subscribe(id: string, listener: (event: ExternalObservation) => boolean): () => void {
    const listeners = this.observers.get(id) ?? new Set();
    this.observers.set(id, listeners);
    listeners.add(listener);
    listener({ kind: 'refresh', epoch: this.observationEpoch, revision: this.revisions.get(id) ?? 0 });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.observers.delete(id);
    };
  }
  async settings(signal?: AbortSignal): Promise<ExternalAgentSettings> {
    const value = await this.command<ExternalAgentSettings>({ action: 'settings' }, signal);
    return {
      ...value,
      agents: [...value.agents, ...defaults.filter((d) => !value.agents.some((a) => a.id === d.id))],
    };
  }
  async configure(value: Omit<ExternalAgentSettings, 'revision'>, expectedRevision: number, key: string) {
    if (
      !value ||
      !Array.isArray(value.agents) ||
      new Set(value.agents.map((v) => v.id)).size !== value.agents.length
    )
      throw new ExternalAgentError('invalid_settings', 'External Agent identities must be unique');
    for (const a of value.agents) {
      if (
        !a ||
        Object.keys(a).some(
          (key) => !['id', 'name', 'harness', 'enabled', 'command', 'args'].includes(key),
        ) ||
        !text(a.id).trim() ||
        !text(a.name).trim() ||
        !text(a.command).trim() ||
        !['codex', 'claude', 'pi', 'acp'].includes(a.harness) ||
        typeof a.enabled !== 'boolean' ||
        !Array.isArray(a.args) ||
        !a.args.every((v) => typeof v === 'string')
      )
        throw new ExternalAgentError('invalid_settings', 'Invalid external Agent configuration');
    }
    if (value.defaultAgent !== null && !value.agents.some((v) => v.id === value.defaultAgent))
      throw new ExternalAgentError('invalid_default', 'The default Agent configuration is unavailable');
    const result = await this.command<ExternalAgentSettings>({
      action: 'configure',
      value,
      expectedRevision,
      key,
    });
    this.notify('*');
    return result;
  }
  private async configuration(id: string) {
    const config = (await this.settings()).agents.find((a) => a.id === id);
    if (!config) throw new ExternalAgentError('agent_missing', 'External Agent configuration is unavailable');
    return config;
  }
  private async executable(
    config: ExternalAgentConfiguration,
  ): Promise<{ executable: string; command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const env = { ...process.env, ...this.environment.getLoginShellEnvSnapshot() };
    const executable = path.isAbsolute(config.command)
      ? config.command
      : this.environment.searchPathFor(config.command, env.PATH ?? env.Path);
    if (!executable || !(await stat(executable).catch(() => null))?.isFile())
      throw new ExternalAgentError('program_missing', `Cannot find ${config.command} on this Host`);
    if (process.platform === 'win32' && /\.cmd$/i.test(executable)) {
      // npm shims invoke a JS entry point; run that entry directly without a shell quoting layer.
      const shim = await readFile(executable, 'utf8');
      const entry = /"%dp0%[\\/]([^"\r\n]+\.(?:c?js|mjs))"/i.exec(shim)?.[1];
      if (!entry)
        throw new ExternalAgentError(
          'launcher_required',
          'Select the executable and arguments used by this command script',
        );
      const node = this.environment.searchPathFor('node', env.PATH ?? env.Path) ?? process.execPath;
      return {
        executable,
        command: node,
        args: [path.resolve(path.dirname(executable), entry), ...config.args],
        env: { ...env, ...(node === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      };
    }
    return { executable, command: executable, args: config.args, env };
  }
  async detect(id: string, signal?: AbortSignal) {
    const config = await this.configuration(id);
    try {
      const launch = await this.executable(config);
      const cwd = path.join(this.deps.directory, 'probe');
      await mkdir(cwd, { recursive: true });
      const child = await this.deps.spawn(launch.command, [...launch.args, '--version'], {
        cwd,
        env: launch.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.resume();
      try {
        await child.completion;
        if (child.exitCode !== 0) throw new Error(`Program version check exited with ${child.exitCode}`);
        return {
          id,
          status: 'available' as const,
          executable: launch.executable,
          version: Buffer.concat(stdout).toString('utf8').trim(),
        };
      } finally {
        if (child.exitConfirmed) await child.release();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        id,
        status:
          error instanceof ExternalAgentError && error.code === 'program_missing'
            ? ('missing' as const)
            : ('failed' as const),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  list(signal?: AbortSignal) {
    return this.command<ExternalConversation[]>({ action: 'list' }, signal);
  }
  async create(input: { key: string; configurationId: string; cwd?: string; title?: string }) {
    const config = await this.configuration(input.configurationId);
    if (!config.enabled)
      throw new ExternalAgentError(
        'agent_disabled',
        'Enable this external Agent before starting a conversation',
      );
    const id = `external:${createHash('sha256').update(input.key).digest('hex')}`;
    let cwd = input.cwd;
    if (!cwd) {
      cwd = path.join(this.deps.directory, 'workspaces', id.slice(9));
      await mkdir(cwd, { recursive: true });
    }
    if (!path.isAbsolute(cwd))
      throw new ExternalAgentError('invalid_directory', 'Choose an absolute working directory');
    const source = await this.deps.resolveWorkspace(cwd);
    const native=await this.deps.kernel.nativeWorkspaces?.resolvePath(cwd);
    const result = await this.command<ExternalConversation>({
      action: 'create',
      ...input,
      id,
      configurationId: config.id,
      harness: config.harness,
      cwd,
      workspaceId: source.workspaceId,
      ...(native?{nativeWorkspace:{...native.reference,resource_owner:{kind:'local'},mode:'native_workspace',revision:null,live_root:null}}:{}),
      privateWorkspace: !input.cwd,
      title: input.title || config.name,
    });
    this.notify(id, true);
    return result;
  }
  async read(id: string, before?: number, signal?: AbortSignal): Promise<ExternalConversationSnapshot> {
    let value: Omit<
      ExternalConversationSnapshot,
      'connected' | 'interactions' | 'observationEpoch' | 'observationRevision'
    >;
    for (;;) {
      const revision = this.structuralRevisions.get(id) ?? 0;
      value = await this.command({ action: 'read', id, ...(before === undefined ? {} : { before }) }, signal);
      if (revision === (this.structuralRevisions.get(id) ?? 0)) break;
    }
    const live = this.connections.get(id);
    const items = new Map(value.items.map((v) => [v.id, v]));
    if (before === undefined)
      for (const item of this.projectedItems.get(id)?.values() ?? []) items.set(item.id, item);
    return {
      ...value,
      observationEpoch: this.observationEpoch,
      observationRevision: this.revisions.get(id) ?? 0,
      items: [...items.values()],
      connected: Boolean(live && !live.peer.disconnected),
      capabilities: live?.connection.capabilities,
      interactions: [...(live?.interactions.values() ?? [])].map((v) => v.request),
    };
  }
  async connect(id: string) {
    const live = await this.connection(id);
    await this.command({ action: 'reconnected', id, sessionId: live.connection.sessionId });
    this.advance(id);
    this.notify(id, true);
    return live.connection.capabilities;
  }
  private async connection(
    id: string,
    launch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>,
  ): Promise<Live> {
    if (this.retiring.has(id))
      throw new ExternalAgentError('conversation_deleting', 'This conversation is being deleted');
    const pending = this.connecting.get(id);
    if (pending) {
      await pending;
      return this.connection(id, launch);
    }
    const controller = new AbortController();
    this.connectionControllers.set(id, controller);
    const opening = Promise.resolve()
      .then(async () => {
        const live = this.connections.get(id);
        if (live && !live.peer.disconnected && (!launch || live.launchKey === launchKey(launch))) return live;
        if (live) {
          await live.connection.close();
          if (this.connections.get(id) === live) this.connections.delete(id);
        }
        controller.signal.throwIfAborted();
        return this.open(id, controller.signal, launch);
      })
      .finally(() => {
        if (this.connecting.get(id) === opening) {
          this.connecting.delete(id);
          this.connectionControllers.delete(id);
        }
      });
    this.connecting.set(id, opening);
    return opening;
  }
  private async open(
    id: string,
    signal: AbortSignal,
    frozenLaunch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>,
  ): Promise<Live> {
    if (this.stopping) throw new Error('External Agent service is stopping');
    const { conversation: c } = await this.read(id);
    const selected =
      (await this.settings()).agents.find((agent) => agent.id === c.configurationId) ??
      (frozenLaunch
        ? { ...frozenLaunch, id: c.configurationId, name: c.harness, harness: c.harness, enabled: false }
        : await this.configuration(c.configurationId));
    const config = frozenLaunch ? { ...selected, ...frozenLaunch, harness: c.harness } : selected;
    if (!config.enabled && !frozenLaunch)
      throw new ExternalAgentError('agent_disabled', 'Enable this external Agent to reconnect');
    if (config.harness !== c.harness)
      throw new ExternalAgentError('backend_changed', 'This configuration now points to another harness');
    let admittedSource:
      { workspaceId: string; executionWorkspaceId: string; canonicalRoot: string } | undefined;
    let executionCwd=c.cwd;
    if (c.parent && this.sources && this.deps.spawnAdmitted) {
      const child = (await this.children()).find(
        (child) => child.operation_id === c.parent!.operationId && child.conversation_id === id,
      );
      if (!child) throw new Error('The original external delegation is unavailable');
      const source = child.handoff
        ? await this.sources.prepare(child, signal)
        : { ...(await this.deps.resolveWorkspace(c.cwd)), cwd: c.cwd };
      if (source.cwd !== c.cwd && record(record(source).nativeSource).mode!=='native_workspace') throw new Error('The external conversation source changed');
      executionCwd=source.cwd;
      admittedSource = {
        workspaceId: source.workspaceId,
        executionWorkspaceId: text(record(source).executionWorkspaceId) || source.workspaceId,
        canonicalRoot: source.cwd,
      };
    } else if(c.nativeWorkspace){
      const owner=this.deps.kernel.nativeWorkspaces;if(!owner||!this.deps.spawnAdmitted)throw new Error('Native external workspace admission is unavailable');
      const entry=await owner.open(c.nativeWorkspace,signal),view=await owner.acquire(c.nativeWorkspace,entry.grant,signal);
      executionCwd=view.path;admittedSource={workspaceId:c.nativeWorkspace.workspace_id,executionWorkspaceId:c.nativeWorkspace.execution_workspace_id,canonicalRoot:view.path};
    }else await this.deps.resolveWorkspace(c.cwd);
    const launch = await this.executable(config);
    const command = config.harness === 'claude' ? process.execPath : launch.command;
    const args =
      config.harness === 'claude'
        ? [fileURLToPath(new URL('./claude-worker.js', import.meta.url))]
        : [
            ...launch.args,
            ...(config.harness === 'codex'
              ? ['app-server']
              : config.harness === 'pi'
                ? ['--mode', 'rpc', ...(c.sessionId ? ['--session', c.sessionId] : [])]
                : []),
          ];
    signal.throwIfAborted();
    const spawnOptions = {
      cwd: executionCwd,
      env: { ...launch.env, ...(config.harness === 'claude' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal,
    };
    const child = admittedSource
      ? await this.deps.spawnAdmitted!(async () => admittedSource!, command, args, spawnOptions)
      : await this.deps.spawn(command, args, spawnOptions);
    const peer = new HarnessTransport(child, config.harness === 'pi' ? 'pi' : 'rpc');
    try {
      const connection =
        config.harness === 'codex'
          ? await connectCodex(peer, executionCwd, c.sessionId)
          : config.harness === 'pi'
            ? await connectPi(peer, c.sessionId)
            : config.harness === 'claude'
              ? await connectClaude(peer, { command: launch.command, args: launch.args }, executionCwd, c.sessionId)
              : await connectAcp(peer, executionCwd, c.sessionId);
      await this.command({ action: 'bind', id, sessionId: connection.sessionId });
      if (this.stopping) throw new Error('External Agent service stopped during connection');
      const live: Live = { connection, peer, interactions: new Map(), launchKey: launchKey(config) };
      this.connections.set(id, live);
      peer.onExit((error) => {
        // Retain ownership until the native process tree is joined. A broken protocol
        // alone must not permit a second writer in the same workspace/session.
        void peer
          .close()
          .then(() => {
            if (this.connections.get(id) === live) this.connections.delete(id);
            this.notify(id);
          })
          .catch((error) => this.deps.onError?.(id, error));
        for (const waiter of live.interactions.values()) waiter.reject(error);
        live.interactions.clear();
        this.notify(id);
      });
      this.notify(id, true);
      return live;
    } catch (error) {
      try {
        await peer.close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'External Agent preparation failed and process exit is unconfirmed',
        );
      }
      throw error;
    }
  }
  async send(id: string, key: string, input: ExternalInput): Promise<ExternalTurn> {
    if (
      Object.keys(input).some((key) => !['text', 'images', 'model', 'thinking', 'mode'].includes(key)) ||
      ['model', 'thinking', 'mode'].some(
        (key) =>
          input[key as keyof ExternalInput] !== undefined &&
          typeof input[key as keyof ExternalInput] !== 'string',
      ) ||
      (input.images !== undefined &&
        (!Array.isArray(input.images) ||
          input.images.some(
            (i) =>
              !i ||
              typeof i.data !== 'string' ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(i.data) ||
              !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(i.mimeType),
          )))
    )
      throw new ExternalAgentError('invalid_input', 'Invalid external Agent input');
    if (!input || typeof input.text !== 'string' || (!input.text.trim() && !input.images?.length))
      throw new ExternalAgentError('empty_input', 'Enter a message');
    const snapshot = await this.read(id);
    const previous = snapshot.turns.find((turn) => turn.key === key);
    if (previous) {
      const { _launch: _frozen, ...original } = await this.command<ExternalInput & { _launch?: unknown }>({
        action: 'input',
        id,
        turnId: previous.id,
        original: true,
      });
      if (!isDeepStrictEqual(original, input))
        throw new ExternalAgentError(
          'input_changed',
          'This request key already belongs to another input',
          409,
        );
      return previous;
    }
    const config = await this.configuration(snapshot.conversation.configurationId);
    if (!config.enabled)
      throw new ExternalAgentError('agent_disabled', 'Enable this external Agent before sending');
    if (config.harness !== snapshot.conversation.harness)
      throw new ExternalAgentError(
        'backend_changed',
        'This conversation uses another harness; start a new conversation for the new backend',
      );
    const receipt = await this.command<ExternalTurn>({
      action: 'admit',
      id,
      key,
      input: { ...input, _launch: { command: config.command, args: config.args } },
    });
    this.notify(id, true);
    this.advance(id);
    return receipt;
  }
  private advance(id: string) {
    if (this.running.has(id) || this.stopping || this.retiring.has(id)) return;
    const work = this.drain(id).finally(async () => {
      if (this.running.get(id) !== work) return;
      this.running.delete(id);
      if (!this.stopping) {
        const snapshot = await this.read(id);
        if (
          !snapshot.conversation.activeTurn &&
          !snapshot.conversation.needsReview &&
          snapshot.turns.some((t) => t.status === 'queued')
        )
          this.advance(id);
      }
    });
    this.running.set(id, work);
    void work.catch(() => this.notify(id));
  }
  private async drain(id: string) {
    while (!this.stopping) {
      const snapshot = await this.read(id);
      if (snapshot.conversation.needsReview) return;
      const turn = snapshot.turns.find((t) => t.status === 'queued');
      if (!turn || snapshot.conversation.activeTurn) return;
      await this.command({ action: 'begin', id, turnId: turn.id });
      this.notify(id);
      let live: Live | undefined;
      let dispatched = false;
      let usage: ExternalTurn['usage'];
      let persistence = Promise.resolve();
      const changed = new Map<string, ExternalItem>();
      const visible = new Map<string, ExternalItem>();
      this.projectedItems.set(id, visible);
      const flush = () => {
        const items = [...changed.values()];
        changed.clear();
        persistence = persistence.then(async () => {
          for (const item of items)
            await this.command({ action: 'item', id, turnId: turn.id, itemId: item.id, content: item });
        });
        void persistence.catch(() => {});
        return persistence;
      };
      const publish = (item: Omit<ExternalItem, 'turnId'>) => {
        const value = { ...item, id: `${turn.id}:${item.id}`, turnId: turn.id };
        const previous = visible.get(value.id);
        let progress: ExternalObservationChange = { kind: 'item', item: value };
        if (
          previous &&
          previous.kind === value.kind &&
          (value.kind === 'assistant' || value.kind === 'reasoning') &&
          value.text.startsWith(previous.text)
        )
          progress = {
            kind: 'text_delta',
            id: value.id,
            turnId: turn.id,
            text: value.text.slice(previous.text.length),
            complete: value.complete,
          };
        else if (previous?.tool && value.tool)
          for (const field of ['input', 'output'] as const) {
            const old = previous.tool[field],
              next = value.tool[field];
            if (
              typeof old === 'string' &&
              typeof next === 'string' &&
              next.startsWith(old) &&
              isDeepStrictEqual(
                { ...previous.tool, [field]: undefined },
                { ...value.tool, [field]: undefined },
              )
            ) {
              progress = {
                kind: 'tool_delta',
                id: value.id,
                turnId: turn.id,
                field,
                text: next.slice(old.length),
              };
              break;
            }
          }
        visible.set(value.id, value);
        changed.set(value.id, value);
        this.notify(id, false, progress);
        // Keep streaming in memory; persist real completed items and the last observed
        // snapshot on turn end/disconnect. Rewriting a growing body on every timer creates
        // quadratic temporary storage for long answers and file writes.
        if (!previous || item.complete || (item.tool && item.tool.status !== 'running')) void flush().catch(() => {});
      };
      try {
        const input = await this.command<
          ExternalInput & {
            task?: string;
            senderThreadId?: string;
            messages?: Array<{ task: string; senderThreadId: string }>;
            _launch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>;
          }
        >({ action: 'input', id, turnId: turn.id });
        for (const [index, message] of (input.messages ?? []).entries())
          publish({
            id: `inform:${index}`,
            kind: 'notice',
            text: message.task,
            senderThreadId: message.senderThreadId,
          });
        publish({
          id: 'user',
          kind: 'user',
          text: input.task ?? input.text,
          ...(input.senderThreadId ? { senderThreadId: input.senderThreadId } : {}),
          ...(input.images?.length ? { images: input.images } : {}),
        });
        await flush();
        if ((await this.read(id)).turns.find((t) => t.id === turn.id)?.status === 'stopping')
          throw new Error('External Agent startup cancelled');
        live = await this.connection(id, input._launch);
        if ((await this.read(id)).turns.find((t) => t.id === turn.id)?.status === 'stopping')
          throw new Error('External Agent startup cancelled');
        if (input.images?.length && !live.connection.capabilities.images)
          throw new ExternalAgentError('images_unsupported', 'This Agent does not accept image input');
        await this.command({ action: 'observe', id, turnId: turn.id, status: 'running' });
        dispatched = true;
        const result = await live.connection.prompt(input, {
          started: (nativeId) => {
            // Serialize binding with body persistence so a fast final receipt cannot
            // overtake the original turn identity.
            persistence = persistence.then(() =>
              this.command<void>({ action: 'native_turn', id, turnId: turn.id, nativeId }),
            );
            void persistence.catch(() => {});
          },
          item: publish,
          usage: (value) => {
            usage = value;
          },
          interaction: (request) =>
            new Promise((resolve, reject) => {
              live!.interactions.set(request.id, {
                request: { ...request, turnId: turn.id },
                resolve,
                reject,
              });
              void this.command({ action: 'observe', id, turnId: turn.id, status: 'waiting_user' }).then(
                () => this.notify(id),
                reject,
              );
            }),
        });
        await flush();
        await this.command({
          action: 'observe',
          id,
          turnId: turn.id,
          status: result.status,
          error: result.error,
          nativeId: result.nativeId,
          usage,
        });
      } catch (error) {
        await flush().catch(() => {});
        const current = (await this.read(id)).turns.find((v) => v.id === turn.id);
        const stoppedPreparation =
          !dispatched && current?.status === 'stopping' && !(error instanceof AggregateError);
        await this.command({
          action: 'observe',
          id,
          turnId: turn.id,
          status: stoppedPreparation ? 'cancelled' : dispatched ? 'interrupted' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        for (const waiter of live?.interactions.values() ?? [])
          waiter.reject(new Error('The external turn ended'));
        live?.interactions.clear();
        this.projectedItems.delete(id);
        this.notify(id, true);
        this.maintenance?.();
      }
    }
  }
  async stop(id: string, turnId: string) {
    const snapshot = await this.read(id);
    const turn = snapshot.turns.find((t) => t.id === turnId);
    if (!turn) throw new ExternalAgentError('turn_missing', 'External turn is unavailable');
    if (ended(turn)) return;
    if (turn.status === 'queued') {
      await this.command({ action: 'observe', id, turnId, status: 'cancelled' });
      this.notify(id);
      return;
    }
    const live = this.connections.get(id);
    if (!live && (this.connectionControllers.has(id) || turn.status === 'preparing')) {
      await this.command({ action: 'observe', id, turnId, status: 'stopping' });
      this.connectionControllers.get(id)?.abort(new Error('External Agent startup was cancelled'));
      this.notify(id);
      return;
    }
    if (!live) throw new ExternalAgentError('not_connected', 'Reconnect before controlling this Agent');
    await this.command({ action: 'observe', id, turnId, status: 'stopping' });
    await live.connection.stop();
    this.notify(id);
  }
  async respond(
    id: string,
    requestId: string,
    response: { optionId?: string; answers?: Record<string, string[]>; text?: string },
  ) {
    const live = this.connections.get(id),
      waiter = live?.interactions.get(requestId);
    if (!live || !waiter)
      throw new ExternalAgentError('interaction_expired', 'This request has already ended');
    const current = (await this.read(id)).turns.find((t) => t.id === waiter.request.turnId);
    if (!current || current.status === 'stopping' || ended(current))
      throw new ExternalAgentError('interaction_expired', 'This turn is stopping or has ended');
    if (waiter.request.options.length && !waiter.request.options.some((v) => v.id === response.optionId))
      throw new ExternalAgentError('invalid_answer', 'Select an available answer');
    live.interactions.delete(requestId);
    await this.command({
      action: 'observe',
      id,
      turnId: waiter.request.turnId,
      status: live.interactions.size ? 'waiting_user' : 'running',
    });
    waiter.resolve(response);
    this.notify(id);
  }
  async update(
    id: string,
    expectedRevision: number,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ) {
    if (!patch.deleted) {
      const value = await this.command<ExternalConversation>({
        action: 'update',
        id,
        expectedRevision,
        ...patch,
      });
      this.notify(id, true);
      return value;
    }
    this.retiring.add(id);
    try {
      if ((await this.read(id)).conversation.activeTurn)
        throw new ExternalAgentError('turn_active', 'Stop this turn before deleting the conversation');
      await this.connecting.get(id);
      await this.connections.get(id)?.connection.close();
      this.connections.delete(id);
      const value = await this.command<ExternalConversation>({
        action: 'update',
        id,
        expectedRevision,
        ...patch,
      });
      this.notify(id, true);
      await this.cleanupDeleted();
      this.maintenance?.();
      return value;
    } finally {
      this.retiring.delete(id);
    }
  }
  private cleanupDeleted(): Promise<void> {
    this.cleanupDirty = true;
    if (this.cleanupWork) return this.cleanupWork;
    const work = (async () => {
      while (this.cleanupDirty) {
        this.cleanupDirty = false;
        for (const c of await this.command<ExternalConversation[]>({ action: 'cleanup_list' })) {
          const child = c.parent
            ? (await this.children()).find((v) => v.conversation_id === c.id)
            : undefined;
          if (child && record(child.source).kind === 'isolated') {
            if (!this.sources) throw new Error('External source owner is unavailable');
            await this.sources.remove(child);
          } else if (c.privateWorkspace && c.workspaceId) {
            const directory = path.resolve(c.cwd),
              container = path.resolve(this.deps.directory, 'workspaces');
            if (path.dirname(directory) !== container)
              throw new Error('Private conversation directory has changed');
            const grant = await this.deps.kernel.issueGrant({
              grantId: `external-cleanup:${randomUUID()}`,
              owningWorkspace: c.workspaceId,
              executionWorkspace: c.workspaceId,
              capabilities: ['storage.read', 'storage.write'],
              pathScopes: [''],
            });
            try {
              const actor = this.deps.kernel.scoped(grant),
                root = await actor.fileRootRegister({
                  workspaceId: c.workspaceId,
                  executionWorkspaceId: c.workspaceId,
                  canonicalRoot: container,
                });
              await actor.fileRemove({
                operationId: `external-directory-delete:${c.id}`,
                workspaceId: c.workspaceId,
                rootId: String(root.rootId),
                path: path.basename(directory),
                recursive: true,
                force: true,
              });
            } finally {
              await this.deps.kernel.revokeGrant(grant.grantId);
            }
          }
          await this.command({ action: 'cleaned', id: c.id });
        }
      }
      this.maintenance?.();
    })().finally(() => {
      if (this.cleanupWork === work) this.cleanupWork = undefined;
    });
    this.cleanupWork = work;
    return work;
  }
  async close() {
    this.stopping = true;
    this.removeChildrenListener?.();
    for (const task of this.childTasks.values()) task.controller.abort();
    await Promise.allSettled([...this.childTasks.values()].map((task) => task.work));
    for (const controller of this.connectionControllers.values())
      controller.abort(new Error('Application Host is stopping'));
    await Promise.allSettled([...this.connecting.values()]);
    const results = await Promise.allSettled(
      [...this.connections.values()].map((live) => live.connection.close()),
    );
    await Promise.allSettled([...this.running.values()]);
    if (this.cleanupWork) await this.cleanupWork;
    this.connections.clear();
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length) throw new AggregateError(errors, 'External Agent shutdown did not complete');
  }
}
