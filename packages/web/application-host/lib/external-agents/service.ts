import { prepareQuoteSelections } from '../kernel/thread-quotes.js';
import { parseAttachmentImageReferences } from '../kernel/thread-images.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  ExternalAgentError,
  isExternalInteractionValueValid,
  type ExternalAgentConfiguration,
  type ExternalAgentSettings,
  type ExternalAgentProfile,
  type ExternalConversation,
  type ExternalConversationSnapshot,
  type ExternalInput,
  type ExternalInteraction,
  type ExternalInteractionResponse,
  type ExternalItem,
  type ExternalTurn,
  type ExternalObservation,
  type ExternalObservationChange,
} from '@varin/application-client';
import { captureExternalFile, releaseExternalCaptures, restoreExternalCapture } from './attachment-capture.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { createKernelProcessService } from '../kernel/process-service.js';
import { createPlatformEnvironmentRuntime } from '../platform/environment-runtime.js';
import { HarnessTransport, record, text } from './transport.js';
import type { HarnessConnection } from './adapter.js';
import { ACP_DEFAULTS, ACP_PROFILES, getAcpProfile } from './profiles.js';
import { assertProfilePlatform, profileVersionArguments } from './profile-launch.js';
import { findInstalledExternalExecutable } from './installed-executable.js';
import { cacheableCapabilities, capabilityConfiguration } from './capability-cache.js';
import { connectCodex } from './codex.js';
import { connectPi } from './pi.js';
import { connectAcp } from './acp.js';
import { connectClaude } from './claude.js';
import type { ExternalChild } from '../kernel/protocol.generated.js';
import { parseExternalAttachmentSelections, prepareHarnessInput, type AcceptedExternalInput, type ExternalAttachmentOwner } from './attachments.js';
import type { createExternalSourceOwner } from './source.js';

const defaults: ExternalAgentConfiguration[] = [
  { id: 'codex', name: 'Codex', harness: 'codex', command: 'codex', args: [], enabled: false },
  { id: 'claude', name: 'Claude Code', harness: 'claude', command: 'claude', args: [], enabled: false },
  { id: 'pi', name: 'Pi', harness: 'pi', command: 'pi', args: [], enabled: false },
  ...ACP_DEFAULTS,
];
type Spawn = ReturnType<typeof createKernelProcessService>['spawn'];
interface Live {
  generation: string;
  configuration: ExternalAgentConfiguration;
  agentVersion?: string;
  capabilityGeneration: number | null;
  idleSince?: number | undefined;
  closing?: boolean;
  failure?: Error;
  dispose: Array<() => void>;
  launchKey: string;
  connection: HarnessConnection;
  peer: HarnessTransport;
  interactions: Map<
    string,
    {
      request: ExternalInteraction;
      resolve(value: ExternalInteractionResponse): void;
      cleanup(): void;
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
  private readonly authenticating = new Set<string>();
  private readonly disconnecting = new Map<string, Promise<void>>();
  private readonly connectionControllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly observers = new Map<string, Set<(event: ExternalObservation) => boolean>>();
  private readonly observationEpoch = randomUUID();
  private readonly structuralRevisions = new Map<string, number>();
  private readonly projectedItems = new Map<string, Map<string, ExternalItem>>();
  private readonly revisions = new Map<string, number>();
  private readonly environment = createPlatformEnvironmentRuntime();
  private stopping = false;
  private readonly connectionStates = new Map<string, NonNullable<ExternalConversationSnapshot['connection']>>();
  private readonly reclaiming = new Map<string, Promise<void>>();
  private readonly cacheWrites = new Set<Promise<void>>();
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private sweeping: Promise<void> | undefined;
  private sources?: ReturnType<typeof createExternalSourceOwner>;
  private removeChildrenListener?: () => void;
  private readonly childTasks = new Map<
    string,
    { conversationId: string; controller: AbortController; work: Promise<void>; recheck: boolean }
  >();
  private discoveringChildren = false;
  private childrenDirty = false;
  private childrenVersion = '';
  private readonly retiring = new Set<string>();
  private attachments?: ExternalAttachmentOwner;
  private readonly inputAdmissions = new Map<string, Set<{ controller: AbortController; work: Promise<unknown> }>>();
  private readonly attachmentPreparations = new Map<string, { turnId: string; controller: AbortController }>();
  bindAttachments(owner: ExternalAttachmentOwner) {
    this.attachments = owner;
    owner.bindExternalPathCapture?.(async (identity, key, selectedPath, signal) => {
      const { conversation } = await this.read(identity.id, undefined, signal);
      if (this.retiring.has(identity.id)) throw new ExternalAgentError('conversation_busy', 'The original conversation is being deleted');
      const retained = await restoreExternalCapture(this.deps.kernel, conversation, key, selectedPath, signal);
      if (retained) return retained;
      const source = await this.executionSource(conversation, signal ?? new AbortController().signal);
      const fallback = source.admittedSource ? undefined : await this.deps.resolveWorkspace(source.executionCwd);
      let workspace: { workspaceId: string; executionWorkspaceId: string; canonicalRoot: string } = source.admittedSource ?? {
        workspaceId: fallback!.workspaceId, executionWorkspaceId: fallback!.workspaceId, canonicalRoot: source.executionCwd,
      };
      if (path.isAbsolute(selectedPath)) {
        const relative = path.relative(workspace.canonicalRoot, selectedPath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          const admitted = await this.deps.resolveWorkspace(path.dirname(selectedPath));
          workspace = { workspaceId: admitted.workspaceId, executionWorkspaceId: admitted.workspaceId, canonicalRoot: admitted.root };
        }
      }
      return captureExternalFile(this.deps.kernel, conversation, key, selectedPath, workspace, signal);
    });
  }
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
      /** Host policy defaults, injectable without changing the durable input contract. */
      idle?: { preparedMs?: number; conversationMs?: number; sweepMs?: number };
    },
  ) {
    this.idleTimer = setInterval(() => {
      void this.sweepIdle().catch(error => this.deps.onError?.('external-idle', error));
    }, deps.idle?.sweepMs ?? 60_000);
    this.idleTimer.unref();
  }
  startChildren(sources: ReturnType<typeof createExternalSourceOwner>) {
    this.sources = sources;
    this.removeChildrenListener = this.deps.kernel.onAgentRuntimeEvent((event) => {
      // The native stream carries a durable cursor, not the individual domain event kind.
      if (event.stream === 'durable') { void this.reconcileChildren(); void this.reconcileArrangements(); }
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
  private reconcilingArrangements = false;
  private arrangementsDirty = false;
  private async reconcileArrangements() {
    this.arrangementsDirty = true;
    if (this.reconcilingArrangements || this.stopping) return;
    this.reconcilingArrangements = true;
    try {
      while (this.arrangementsDirty && !this.stopping) {
        this.arrangementsDirty = false;
        const ids = await this.command<string[]>({ action: 'arrangement_pending' });
        for (const id of ids) this.advance(id);
      }
    } catch (error) { this.deps.onError?.('external-arrangements', error); }
    finally { this.reconcilingArrangements = false; }
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
          const task = { conversationId: child.conversation_id, controller, work: Promise.resolve(), recheck: false };
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
        this.removeObserver(id, listener);
    this.touchActivity(id);
    if (catalog && id !== '*')
      for (const listener of this.observers.get('*') ?? [])
        if (!listener({ kind: 'refresh', epoch: this.observationEpoch, revision: this.revisions.get('*')! }))
          this.observers.get('*')?.delete(listener);
  }
  private removeObserver(id: string, listener: (event: ExternalObservation) => boolean) {
    const listeners = this.observers.get(id);
    if (!listeners?.delete(listener)) return;
    if (!listeners.size) { this.observers.delete(id); this.touchActivity(id); }
  }
  private touchActivity(id: string) {
    const live = this.connections.get(id);
    if (live) live.idleSince = this.observers.get(id)?.size ? undefined : Date.now();
  }
  subscribe(id: string, listener: (event: ExternalObservation) => boolean): () => void {
    const listeners = this.observers.get(id) ?? new Set();
    this.observers.set(id, listeners);
    listeners.add(listener);
    this.touchActivity(id);
    if (!listener({ kind: 'refresh', epoch: this.observationEpoch, revision: this.revisions.get(id) ?? 0 }))
      this.removeObserver(id, listener);
    return () => this.removeObserver(id, listener);
  }
  private async claimCapabilities(configuration: ExternalAgentConfiguration) {
    return this.command<number | null>({ action: 'claim_capabilities', configurationId: configuration.id,
      configuration: capabilityConfiguration(configuration) });
  }
  private async invalidateCapabilities(configuration: ExternalAgentConfiguration, generation: number) {
    await this.command({ action: 'cache_capabilities', configurationId: configuration.id,
      configuration: capabilityConfiguration(configuration), generation, invalidate: true });
    this.notify('*');
  }
  private cacheCapabilities(live: Live): Promise<void> {
    const capabilities = live.connection.capabilities;
    const agentVersion = live.agentVersion ?? capabilities.protocol?.agentVersion;
    // Failed discovery and unknown program versions are not reusable capability catalogs.
    if (live.closing || live.failure || live.capabilityGeneration === null) return Promise.resolve();
    const work = this.command<void>({ action: 'cache_capabilities', configurationId: live.configuration.id,
      configuration: capabilityConfiguration(live.configuration), agentVersion, generation: live.capabilityGeneration,
      ...(agentVersion && !capabilities.modelsError ? { capabilities: cacheableCapabilities(capabilities) } : {}) })
      .then(() => this.notify('*'))
      .catch(error => this.deps.onError?.('external-capabilities', error))
      .finally(() => this.cacheWrites.delete(work));
    this.cacheWrites.add(work);
    return work;
  }
  private idleBlocked(id: string, live: Live): boolean {
    // A retained binding cannot be replaced with a new native session. Keep a non-resumable
    // connection alive: automatic reclamation would otherwise destroy the only continuation.
    return Boolean(!live.connection.capabilities.resume || this.stopping || live.closing || live.failure || live.peer.disconnected || live.connection.failure ||
      this.observers.get(id)?.size || this.connecting.has(id) || this.running.has(id) || this.retiring.has(id) ||
      this.authenticating.has(id) || this.inputAdmissions.get(id)?.size || this.attachmentPreparations.has(id) ||
      live.interactions.size || live.connection.backgroundTasks ||
      [...this.childTasks.values()].some(task => task.conversationId === id));
  }
  /** Reclamation is a process-owner close, never observer cancellation or binding deletion. */
  private sweepIdle(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const work = (async () => {
      for (const [id, live] of this.connections) {
        if (this.idleBlocked(id, live)) { live.idleSince = undefined; continue; }
        live.idleSince ??= Date.now();
        const idleSince = live.idleSince;
        // Read the durable queue and delegation receipts, not just transient Host tasks.
        const snapshot = await this.read(id);
        const children = await this.children(true);
        if (snapshot.conversation.activeTurn || snapshot.turns.some(turn => !ended(turn)) ||
          children.some(child => child.conversation_id === id && !child.report)) {
          live.idleSince = undefined;
          continue;
        }
        const timeout = snapshot.turns.length ? this.deps.idle?.conversationMs ?? 15 * 60_000
          : this.deps.idle?.preparedMs ?? 5 * 60_000;
        // Any observation, input admission, native activity or generation change during those
        // reads defeats this candidate. The reservation below seals new Host admissions.
        if (this.connections.get(id) !== live || this.idleBlocked(id, live) || live.idleSince !== idleSince ||
          Date.now() - idleSince < timeout) continue;
        this.retiring.add(id);
        const reclaim = Promise.resolve().then(async () => {
          // An observer can arrive between reservation and this microtask. Do not close then.
          if (this.observers.get(id)?.size || live.connection.backgroundTasks || live.idleSince !== idleSince) return;
          live.closing = true;
          await live.connection.close();
          for (const dispose of live.dispose) dispose();
          if (this.connections.get(id) === live) this.connections.delete(id);
          this.connectionStates.set(id, { status: 'reclaimed' });
          this.notify(id);
        }).catch(error => {
          this.connectionStates.set(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
          this.notify(id);
          throw error;
        }).finally(() => {
          this.retiring.delete(id);
          if (this.reclaiming.get(id) === reclaim) this.reclaiming.delete(id);
          // Native delegations accepted while close was joining remain durable and may now advance.
          if (!this.stopping) this.advance(id);
        });
        this.reclaiming.set(id, reclaim);
        await reclaim;
      }
    })().finally(() => { if (this.sweeping === work) this.sweeping = undefined; });
    this.sweeping = work;
    return work;
  }
  async settings(signal?: AbortSignal): Promise<ExternalAgentSettings> {
    const value = await this.command<ExternalAgentSettings>({ action: 'settings' }, signal);
    return {
      ...value,
      profiles: [...ACP_PROFILES],
      agents: [...value.agents, ...defaults.filter((d) => !value.agents.some((a) => a.id === d.id))],
    };
  }
  async configure(value: Pick<ExternalAgentSettings, 'agents' | 'defaultAgent'>, expectedRevision: number, key: string) {
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
          (key) => !['id', 'name', 'harness', 'enabled', 'command', 'args', 'defaults'].includes(key),
        ) ||
        !text(a.id).trim() ||
        !text(a.name).trim() ||
        !text(a.command).trim() ||
        !['codex', 'claude', 'pi', 'acp'].includes(a.harness) ||
        typeof a.enabled !== 'boolean' ||
        !Array.isArray(a.args) ||
        !a.args.every((v) => typeof v === 'string') ||
        (a.defaults !== undefined && (!a.defaults || typeof a.defaults !== 'object' || Array.isArray(a.defaults) ||
          Object.entries(a.defaults).some(([key, value]) => !['model', 'thinking', 'mode'].includes(key) || typeof value !== 'string' || !value.trim())))
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
    const profile = getAcpProfile(config.id);
    assertProfilePlatform(profile, process.platform, process.arch);
    const env = { ...process.env, ...this.environment.getLoginShellEnvSnapshot() };
    const executable = path.isAbsolute(config.command)
      ? config.command
      : this.environment.searchPathFor(config.command, env.PATH ?? env.Path) ?? await findInstalledExternalExecutable(config);
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
  private async probeVersion(launch: Awaited<ReturnType<ExternalAgentsService['executable']>>, signal?: AbortSignal, profile?: ExternalAgentProfile) {
    const cwd = path.join(this.deps.directory, 'probe');
    await mkdir(cwd, { recursive: true });
    // This deadline bounds only a version query, never a model turn or native effect.
    const timeout = AbortSignal.timeout(15_000);
    const args = profileVersionArguments(launch.args, profile);
    const child = await this.deps.spawn(launch.command, args, {
      cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'],
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, windowsHide: true,
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    try {
      await child.completion;
      if (!child.exitConfirmed) throw new Error('Program version query exit is unconfirmed');
      signal?.throwIfAborted();
      if (timeout.aborted) throw new ExternalAgentError('probe_timeout', 'Program version query did not finish');
      if (child.exitCode !== 0) throw new Error(`Program version check exited with ${child.exitCode}`);
      const version = Buffer.concat(stdout).toString('utf8').trim();
      if (!version) throw new Error('Program version query returned no version');
      return version;
    } catch (error) {
      if (!child.exitConfirmed) throw new AggregateError([error], 'Program version query failed and process exit is unconfirmed');
      throw error;
    } finally {
      if (child.exitConfirmed) await child.release();
    }
  }
  async detect(id: string, signal?: AbortSignal) {
    const config = await this.configuration(id);
    // Observe before external work; a slow old probe must not obtain a newer claim and
    // invalidate capabilities established by a later connection while it was running.
    const observed = await this.command<{ generation: number; agentVersion?: string } | null>({
      action: 'inspect_capabilities', configurationId: id, configuration: capabilityConfiguration(config),
    }, signal);
    try {
      const launch = await this.executable(config);
      const version = await this.probeVersion(launch, signal, getAcpProfile(config.id));
      if (observed?.agentVersion && observed.agentVersion !== version)
        await this.invalidateCapabilities(config, observed.generation);
      return { id, status: 'available' as const, executable: launch.executable, version };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (observed) await this.invalidateCapabilities(config, observed.generation);
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
  async create(input: { key: string; configurationId: string; cwd?: string; title?: string }, principalId?: string | null) {
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
      ...(principalId === undefined ? {} : { principalId }),
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
    const connected = Boolean(live && !live.closing && !live.failure && !live.peer.disconnected && !live.connection.failure);
    const cached = connected ? undefined : (await this.settings(signal)).capabilityCache?.[value.conversation.configurationId];
    const state = this.connectionStates.get(id);
    return {
      ...value,
      observationEpoch: this.observationEpoch,
      observationRevision: this.revisions.get(id) ?? 0,
      items: [...items.values()],
      connected,
      capabilities: connected ? live!.connection.capabilities : cached?.capabilities,
      ...(connected || cached ? { capabilitiesSource: connected ? 'live' as const : 'cached' as const } : {}),
      connection: connected ? { status: 'connected' } : state?.status === 'connected' ? { status: 'disconnected' } : state ?? { status: 'disconnected' },
      ...(connected && live!.connection.contextUsage ? { contextUsage: live!.connection.contextUsage } : {}),
      interactions: [...(live?.interactions.values() ?? [])].map((v) => v.request),
    };
  }
  async connect(id: string) {
    const previous = this.connections.get(id);
    const live = await this.connection(id);
    if (previous === live && live.connection.capabilities.modelsError && live.connection.capabilities.modelsRefresh) {
      await live.connection.refreshCapabilities?.();
      await this.cacheCapabilities(live);
    }
    this.notify(id, true);
    return live.connection.capabilities;
  }
  disconnect(id: string): Promise<void> {
    const pending = this.disconnecting.get(id);
    if (pending) return pending;
    if (this.retiring.has(id)) return Promise.reject(new ExternalAgentError('conversation_busy', 'This conversation is being deleted'));
    this.retiring.add(id);
    const work = Promise.resolve().then(async () => {
      const snapshot = await this.read(id);
      if (snapshot.conversation.activeTurn || snapshot.turns.some((turn) => !ended(turn)) || this.inputAdmissions.get(id)?.size)
        throw new ExternalAgentError('turn_active', 'Stop active or queued turns before disconnecting');
      this.connectionControllers.get(id)?.abort(new ExternalAgentError('connection_cancelled', 'External connection preparation cancelled'));
      await this.connecting.get(id)?.catch(() => {});
      const live = this.connections.get(id);
      if (live) {
        this.cancelInteractions(live);
        live.closing = true;
        await live.connection.close();
        for (const dispose of live.dispose) dispose();
        if (this.connections.get(id) === live) this.connections.delete(id);
      }
      this.connectionStates.set(id, { status: 'disconnected' });
      this.notify(id);
    }).finally(() => {
      this.retiring.delete(id);
      if (this.disconnecting.get(id) === work) this.disconnecting.delete(id);
    });
    this.disconnecting.set(id, work);
    return work;
  }
  async continueConversation(id: string) {
    const live = await this.connection(id);
    await this.command({ action: 'reconnected', id, sessionId: live.connection.sessionId });
    this.advance(id);
    this.notify(id, true);
  }
  async authenticate(id: string, methodId: string) {
    if (this.authenticating.has(id) || this.retiring.has(id) || this.running.has(id))
      throw new ExternalAgentError('conversation_busy', 'Wait for active conversation work before authenticating');
    this.authenticating.add(id);
    try {
      const snapshot = await this.read(id);
      if (snapshot.conversation.activeTurn || snapshot.turns.some((turn) => turn.status === 'queued'))
        throw new ExternalAgentError('turn_active', 'Stop active or queued turns before authenticating');
      if (snapshot.conversation.harness !== 'acp')
        throw new ExternalAgentError('authentication_unsupported', 'Use this harness’s own sign-in command');
      const live = await this.connection(id, undefined, methodId);
      this.notify(id, true);
      return live.connection.capabilities;
    } finally {
      this.authenticating.delete(id);
      this.advance(id);
    }
  }
  private async connection(
    id: string,
    launch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>,
    authMethodId?: string,
  ): Promise<Live> {
    const reclaim = this.reclaiming.get(id);
    if (reclaim) await reclaim;
    if (this.retiring.has(id) || (this.authenticating.has(id) && authMethodId === undefined))
      throw new ExternalAgentError('conversation_busy', 'This conversation is authenticating, disconnecting or being deleted');
    const pending = this.connecting.get(id);
    if (pending) {
      await pending;
      return this.connection(id, launch, authMethodId);
    }
    const controller = new AbortController();
    this.connectionControllers.set(id, controller);
    const opening = Promise.resolve()
      .then(async () => {
        const live = this.connections.get(id);
        if (live && !authMethodId && !live.closing && !live.failure && !live.peer.disconnected && !live.connection.failure && (!launch || live.launchKey === launchKey(launch))) return live;
        this.connectionStates.set(id, { status: 'preparing' });
        this.notify(id);
        if (live) {
          live.closing = true;
          await live.connection.close();
          for (const dispose of live.dispose) dispose();
          if (this.connections.get(id) === live) this.connections.delete(id);
        }
        controller.signal.throwIfAborted();
        return this.open(id, controller.signal, launch, authMethodId);
      })
      .catch(error => {
        this.connectionStates.set(id, {
          status: error instanceof ExternalAgentError && error.code === 'authentication_required' ? 'authentication_required'
            : controller.signal.aborted ? 'disconnected' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        this.notify(id);
        throw error;
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
  private async executionSource(c: ExternalConversation, signal: AbortSignal) {
    let admittedSource:
      { workspaceId: string; executionWorkspaceId: string; canonicalRoot: string } | undefined;
    let executionCwd=c.cwd;
    if (c.parent && this.sources && this.deps.spawnAdmitted) {
      const child = (await this.children()).find(
        (child) => child.operation_id === c.parent!.operationId && child.conversation_id === c.id,
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
    return { executionCwd, admittedSource };
  }
  private async open(
    id: string,
    signal: AbortSignal,
    frozenLaunch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>,
    authMethodId?: string,
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
    const { admittedSource, executionCwd } = await this.executionSource(c, signal);
    const capabilityGeneration = await this.claimCapabilities(config);
    const launch = await this.executable(config);
    const version = await this.probeVersion(launch, signal, getAcpProfile(config.id)).catch(error => {
      if (signal.aborted || config.harness === 'pi' || error instanceof AggregateError) throw error;
      return undefined;
    });
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
            ? await connectPi(peer, c.sessionId, version === undefined ? {} : { version })
            : config.harness === 'claude'
              ? await connectClaude(peer, { command: launch.command, args: launch.args }, executionCwd, c.sessionId)
              : await connectAcp(peer, executionCwd, c.sessionId, { profile: getAcpProfile(c.configurationId), authMethodId });
      const agentVersion = version ?? connection.capabilities.protocol?.agentVersion;
      signal.throwIfAborted();
      await this.command({ action: 'bind', id, sessionId: connection.sessionId });
      if (this.stopping) throw new Error('External Agent service stopped during connection');
      const live: Live = { generation: randomUUID(), configuration: config, capabilityGeneration, ...(agentVersion ? { agentVersion } : {}),
        dispose: [], connection, peer, interactions: new Map(), launchKey: launchKey(config) };
      await this.cacheCapabilities(live);
      signal.throwIfAborted();
      if (this.stopping) throw new Error('External Agent service stopped during connection');
      if (connection.failure) throw connection.failure;
      this.connections.set(id, live);
      this.connectionStates.set(id, { status: 'connected' });
      const retire = (error: Error) => {
        if (live.failure || live.closing) return;
        live.failure = error;
        this.connectionStates.set(id, { status: 'failed', error: error.message });
        // A fatal protocol/session failure also owns the process tree until it is joined.
        this.cancelInteractions(live, undefined, error);
        void connection.close().then(() => {
          for (const dispose of live.dispose) dispose();
          if (this.connections.get(id) === live) this.connections.delete(id);
          this.notify(id);
        }).catch((failure) => this.deps.onError?.(id, failure));
        this.notify(id);
      };
      live.dispose.push(peer.onExit(retire));
      if (connection.onFailure) live.dispose.push(connection.onFailure(retire));
      if (connection.onCapabilities) live.dispose.push(connection.onCapabilities(() => {
        if (this.connections.get(id) !== live) return;
        void this.cacheCapabilities(live);
        this.notify(id);
      }));
      if (connection.onContextUsage) live.dispose.push(connection.onContextUsage(() => {
        if (this.connections.get(id) === live) this.notify(id);
      }));
      if (connection.onActivity) live.dispose.push(connection.onActivity(() => {
        if (this.connections.get(id) === live) this.touchActivity(id);
      }));
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
      if (signal.aborted) throw signal.reason;
      throw error;
    }
  }
  async send(id: string, key: string, input: ExternalInput): Promise<ExternalTurn> {
    const reclaim = this.reclaiming.get(id);
    if (reclaim) await reclaim;
    if (this.retiring.has(id) || this.authenticating.has(id)) throw new ExternalAgentError('conversation_busy', 'This conversation is authenticating, disconnecting or being deleted');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ExternalAgentError('invalid_input', 'Invalid external Agent input');
    if (
      typeof input.text !== 'string' || Object.keys(input).some((key) => !['text', 'images', 'attachments', 'attachmentImageReferences', 'model', 'thinking', 'mode', 'config', 'contentReferences', 'contentReferenceOccurrences'].includes(key)) ||
      (input.config !== undefined && (!input.config || typeof input.config !== 'object' || Array.isArray(input.config) || Object.values(input.config).some((v) => typeof v !== 'string'))) ||
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
    const quoted = prepareQuoteSelections(input);
    input = { ...input, ...quoted.quotes, ...(quoted.images === undefined ? {} : { images: quoted.images }), ...(quoted.attachments.length ? { attachments: quoted.attachments } : {}) };
    parseAttachmentImageReferences(input.attachmentImageReferences);
    const selections = parseExternalAttachmentSelections(input.attachments);
    if (!input || typeof input.text !== 'string' || (!input.text.trim() && !input.images?.length && !selections?.length && !input.contentReferences?.length))
      throw new ExternalAgentError('empty_input', 'Enter a message');
    const snapshot = await this.read(id);
    const previous = snapshot.turns.find((turn) => turn.key === key);
    if (previous) {
      const { _launch: _frozen, _attachmentSelections, attachments: frozenAttachments, ...saved } = await this.command<AcceptedExternalInput & { _launch?: unknown }>({
        action: 'input',
        id,
        turnId: previous.id,
        original: true,
      });
      const original = { ...saved, ...(_attachmentSelections !== undefined ? { attachments: _attachmentSelections } : frozenAttachments !== undefined ? { attachments: frozenAttachments } : {}) };
      if (original.contentReferences) original.contentReferences = original.contentReferences.map(({ attachmentRef: _prepared, ...reference }) => reference);
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
    if (this.retiring.has(id) || this.authenticating.has(id)) throw new ExternalAgentError('conversation_busy', 'This conversation is authenticating, disconnecting or being deleted');
    return this.withInputAdmission(id, async signal => {
      if (snapshot.conversation.deleted) throw new ExternalAgentError('conversation_deleted', 'This conversation no longer accepts input');
      const prepared = selections?.length ? await this.requireAttachments().prepareExternal(snapshot.conversation, key, selections, signal) : undefined;
      signal.throwIfAborted();
      const receipt = await this.command<ExternalTurn>({
        action: 'admit', id, key,
        input: { ...input, ...quoted.bind(prepared ?? []), ...(prepared ? { attachments: prepared, _attachmentSelections: selections } : {}), _launch: { command: config.command, args: config.args } },
      });
      this.notify(id, true);
      this.advance(id);
      return receipt;
    });
  }
  private withInputAdmission<T>(id: string, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.retiring.has(id) || this.stopping) return Promise.reject(new ExternalAgentError('conversation_busy', 'This conversation is closing'));
    const pending = this.inputAdmissions.get(id) ?? new Set();
    this.inputAdmissions.set(id, pending);
    const controller = new AbortController();
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const entry = { controller, work: Promise.resolve() as Promise<unknown> };
    const work = Promise.resolve().then(() => { active.throwIfAborted(); return action(active); }).finally(() => {
      pending.delete(entry);
      if (!pending.size && this.inputAdmissions.get(id) === pending) this.inputAdmissions.delete(id);
    });
    entry.work = work; pending.add(entry);
    return work;
  }
  private async drainInputAdmissions(id: string): Promise<void> {
    const pending = [...this.inputAdmissions.get(id) ?? []];
    for (const entry of pending) entry.controller.abort(new Error('The original conversation is closing'));
    await Promise.allSettled(pending.map(entry => entry.work));
  }
  private requireAttachments() {
    if (!this.attachments) throw new ExternalAgentError('attachments_unavailable', 'The original attachment owner is unavailable');
    return this.attachments;
  }
  async uploadAttachment(id: string, metadata: { key: string; filename: string; mimeType: string; byteLength: number }, chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    return this.withInputAdmission(id, async active => {
      const snapshot = await this.read(id, undefined, active);
      if (snapshot.conversation.deleted) throw new ExternalAgentError('conversation_deleted', 'This conversation no longer accepts files');
      return this.requireAttachments().uploadExternal(snapshot.conversation, metadata, chunks, active);
    }, signal);
  }
  async readAttachment(id: string, ref: string, signal?: AbortSignal) {
    const snapshot = await this.read(id, undefined, signal);
    if (snapshot.conversation.deleted) throw new ExternalAgentError('conversation_deleted', 'This conversation was deleted');
    return this.requireAttachments().readExternal(snapshot.conversation, ref, signal);
  }
  private advance(id: string) {
    if (this.running.has(id) || this.stopping || this.retiring.has(id) || this.authenticating.has(id)) return;
    const work = this.drain(id).finally(async () => {
      if (this.running.get(id) !== work) return;
      this.running.delete(id);
      if (!this.stopping) {
        const snapshot = await this.read(id);
        const next = snapshot.turns.find(t => t.status === 'queued' && !t.arrangementHoldReason && !t.blockedReason);
        if (
          !snapshot.conversation.activeTurn &&
          !snapshot.conversation.needsReview &&
          next && !next.arrangementHoldReason && !next.blockedReason
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
      if (snapshot.conversation.needsReview || this.authenticating.has(id) || this.retiring.has(id)) return;
      const turn = snapshot.turns.find((t) => t.status === 'queued' && !t.arrangementHoldReason && !t.blockedReason);
      if (!turn || turn.arrangementHoldReason || turn.blockedReason || snapshot.conversation.activeTurn) return;
      await this.command({ action: 'begin', id, turnId: turn.id });
      this.notify(id);
      let live: Live | undefined;
      let dispatched = false;
      let includesArrangements = Boolean(turn.arrangementOccurrenceId);
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
          AcceptedExternalInput & {
            task?: string;
            _arrangement?: boolean;
            _eventHistory?: unknown;
            _userInput?: boolean;
            senderThreadId?: string;
            messages?: Array<{ task: string; senderThreadId?: string; _arrangement?: boolean; attachments?: import('@varin/protocol').Attachment[] }>;
            _launch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>;
          }
        >({ action: 'input', id, turnId: turn.id });
        includesArrangements ||= Boolean(input.messages?.some(message => message._arrangement));
        for (const [index, message] of (input.messages ?? []).entries())
          publish({
            id: `inform:${index}`,
            kind: 'notice',
            text: message.task,
            ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          });
        publish({
          id: 'user',
          kind: turn.arrangementOccurrenceId && !input._userInput ? 'notice' : 'user',
          text: input.task ?? input.text,
          ...(input.senderThreadId ? { senderThreadId: input.senderThreadId } : {}),
          ...(input.images?.length ? { images: input.images } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.contentReferences === undefined ? {} : { contentReferences: input.contentReferences }),
          ...(input.contentReferenceOccurrences === undefined ? {} : { contentReferenceOccurrences: input.contentReferenceOccurrences }),
          ...(input.attachmentImageReferences === undefined ? {} : { attachmentImageReferences: input.attachmentImageReferences }),
        });
        await flush();
        if ((await this.read(id)).turns.find((t) => t.id === turn.id)?.status === 'stopping')
          throw new Error('External Agent startup cancelled');
        live = await this.connection(id, turn.arrangementLaunch ?? input._launch);
        if ((await this.read(id)).turns.find((t) => t.id === turn.id)?.status === 'stopping')
          throw new Error('External Agent startup cancelled');
        if (input.images?.length && !live.connection.capabilities.images)
          throw new ExternalAgentError('images_unsupported', 'This Agent does not accept image input');
        const { _launch: _launch, _arrangement: _arrangement, _eventHistory: _eventHistory, _userInput: _userInput, messages: _messages, task: _task, senderThreadId: _sender, ...admitted } = input;
        const preparation = { turnId: turn.id, controller: new AbortController() };
        this.attachmentPreparations.set(id, preparation);
        let harnessInput: Awaited<ReturnType<typeof prepareHarnessInput>>;
        try {
          harnessInput = await prepareHarnessInput({ ...admitted, attachments: [...(input.messages ?? []).flatMap(message => message.attachments ?? []), ...(input.attachments ?? [])] }, snapshot.conversation, live.connection.capabilities, this.attachments, preparation.controller.signal);
        } finally {
          if (this.attachmentPreparations.get(id) === preparation) this.attachmentPreparations.delete(id);
        }
        const generation = live.generation;
        const result = await live.connection.prompt(harnessInput, {
          beforeDispatch: async () => {
            if (dispatched) throw new Error('This external input has already been dispatched');
            if (this.connections.get(id)?.generation !== generation || live!.connection.failure)
              throw new Error('The external connection changed before delivery');
            const current = (await this.read(id)).turns.find((t) => t.id === turn.id);
            if (current?.status === 'stopping') throw new Error('External Agent startup cancelled');
            await this.command({ action: 'observe', id, turnId: turn.id, status: 'running' });
            dispatched = true;
          },
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
          interaction: (request, signal) => new Promise<ExternalInteractionResponse>((resolve, reject) => {
            if (signal?.aborted || this.connections.get(id)?.generation !== generation) {
              resolve({ cancelled: true });
              return;
            }
            const publicId = `${generation}:${turn.id}:${randomUUID()}`;
            const abort = () => {
              const waiter = live!.interactions.get(publicId);
              if (!waiter) return;
              live!.interactions.delete(publicId);
              waiter.cleanup();
              waiter.resolve({ cancelled: true });
              // A native-withdrawn callback is no longer waiting for the user.
              // Catalog rejects this observation if stop/end already won.
              void this.command({ action: 'observe', id, turnId: turn.id,
                status: live!.interactions.size ? 'waiting_user' : 'running' }).then(
                () => this.notify(id), () => this.notify(id),
              );
            };
            live!.interactions.set(publicId, {
              request: { ...request, id: publicId, turnId: turn.id }, resolve, reject,
              cleanup: () => signal?.removeEventListener('abort', abort),
            });
            signal?.addEventListener('abort', abort, { once: true });
            void this.command({ action: 'observe', id, turnId: turn.id, status: 'waiting_user' }).then(
              () => this.notify(id),
              () => abort(),
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
        if (current && ended(current)) return;
        if (!dispatched && includesArrangements && !stoppedPreparation) {
          await this.command({ action: 'defer', id, turnId: turn.id, reason: error instanceof Error ? error.message : String(error) });
          return;
        }
        await this.command({
          action: 'observe',
          id,
          turnId: turn.id,
          status: stoppedPreparation ? 'cancelled' : dispatched ? 'interrupted' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        if (live) this.cancelInteractions(live, turn.id);
        this.projectedItems.delete(id);
        this.notify(id, true);
        this.maintenance?.();
      }
    }
  }
  async stop(id: string, turnId: string, force = false) {
    const snapshot = await this.read(id);
    const turn = snapshot.turns.find((t) => t.id === turnId);
    if (!turn) throw new ExternalAgentError('turn_missing', 'External turn is unavailable');
    if (ended(turn)) return;
    if (turn.status === 'queued' || turn.status === 'awaiting_input') {
      await this.command({ action: 'observe', id, turnId, status: 'cancelled' });
      this.notify(id);
      return;
    }
    const live = this.connections.get(id);
    if (!live && (this.connectionControllers.has(id) || turn.status === 'preparing')) {
      const controller = this.connectionControllers.get(id);
      await this.command({ action: 'observe', id, turnId, status: 'stopping' });
      const latest = await this.read(id);
      const active = latest.turns.find((candidate) => candidate.id === turnId);
      if (!active || ended(active)) return;
      const currentController = this.connectionControllers.get(id);
      if (latest.conversation.activeTurn !== turnId || (controller && currentController !== controller))
        throw new ExternalAgentError('turn_changed', 'The original external preparation is no longer active');
      currentController?.abort(new Error('External Agent startup was cancelled'));
      this.notify(id);
      return;
    }
    if (!live) throw new ExternalAgentError('not_connected', 'Reconnect before controlling this Agent');
    await this.command({ action: 'observe', id, turnId, status: 'stopping' });
    // Catalog observation is asynchronous. A completed old turn must never let
    // a late control request stop its successor on this reusable connection.
    const latest = await this.read(id);
    const active = latest.turns.find((candidate) => candidate.id === turnId);
    if (!active || ended(active)) return;
    if (latest.conversation.activeTurn !== turnId || this.connections.get(id) !== live)
      throw new ExternalAgentError('turn_changed', 'The original external turn is no longer active');
    const preparing = this.attachmentPreparations.get(id);
    if (preparing?.turnId === turnId) {
      preparing.controller.abort(new Error('External attachment preparation was cancelled'));
      this.notify(id);
      return;
    }
    this.cancelInteractions(live, turnId);
    if (force) {
      // Explicit termination joins the Rust-owned process tree. It does not claim that
      // already-performed effects were rolled back or that the interrupted input may replay.
      await live.connection.close();
      await this.running.get(id);
    } else await live.connection.stop();
    this.notify(id);
  }
  private cancelInteractions(live: Live, turnId?: string, error?: Error) {
    for (const [id, waiter] of live.interactions) {
      if (turnId && waiter.request.turnId !== turnId) continue;
      live.interactions.delete(id);
      waiter.cleanup();
      // Cancellation is a protocol response, not an abandoned permission callback.
      if (error && live.peer.disconnected) waiter.reject(error);
      else waiter.resolve({ cancelled: true });
    }
  }
  async respond(
    id: string,
    requestId: string,
    response: ExternalInteractionResponse,
  ) {
    const dictionary = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value));
    if (!dictionary(response) ||
      Object.keys(response).some((key) => !['optionId', 'answers', 'text', 'cancelled', 'values'].includes(key)) ||
      (response.optionId !== undefined && typeof response.optionId !== 'string') ||
      (response.text !== undefined && typeof response.text !== 'string') ||
      (response.cancelled !== undefined && typeof response.cancelled !== 'boolean') ||
      (response.answers !== undefined && (!dictionary(response.answers) || Object.values(response.answers).some((value) => !Array.isArray(value) || value.some((entry) => typeof entry !== 'string')))) ||
      (response.values !== undefined && (!dictionary(response.values) || Object.values(response.values).some((value) =>
        typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value)) &&
        !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))))))
      throw new ExternalAgentError('invalid_answer', 'Invalid external Agent answer');
    const live = this.connections.get(id),
      waiter = live?.interactions.get(requestId);
    if (!live || !waiter)
      throw new ExternalAgentError('interaction_expired', 'This request has already ended');
    const current = (await this.read(id)).turns.find((t) => t.id === waiter.request.turnId);
    if (!current || current.status === 'stopping' || ended(current))
      throw new ExternalAgentError('interaction_expired', 'This turn is stopping or has ended');
    if (!response.cancelled && waiter.request.options.length && !waiter.request.options.some((v) => v.id === response.optionId))
      throw new ExternalAgentError('invalid_answer', 'Select an available answer');
    if (!response.cancelled && waiter.request.fields) {
      const values = response.values as ExternalInteractionResponse['values'];
      const field = waiter.request.fields.find((field) => !isExternalInteractionValueValid(field, values?.[field.id]));
      if (field || Object.keys(response.values ?? {}).some((id) => !waiter.request.fields!.some((field) => field.id === id)))
        throw new ExternalAgentError('invalid_answer', field ? `Invalid value for ${field.label}` : 'Unexpected answer field');
    }
    await this.command({
      action: 'observe',
      id,
      turnId: waiter.request.turnId,
      status: live.interactions.size > 1 ? 'waiting_user' : 'running',
    });
    if (live.interactions.get(requestId) !== waiter)
      throw new ExternalAgentError('interaction_expired', 'This request has already ended');
    live.interactions.delete(requestId);
    waiter.cleanup();
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
    if (this.retiring.has(id) || this.authenticating.has(id)) throw new ExternalAgentError('conversation_busy', 'This conversation is authenticating, disconnecting or being deleted');
    this.retiring.add(id);
    try {
      await this.drainInputAdmissions(id);
      if ((await this.read(id)).conversation.activeTurn)
        throw new ExternalAgentError('turn_active', 'Stop this turn before deleting the conversation');
      await this.connecting.get(id);
      const live = this.connections.get(id);
      await live?.connection.close();
      for (const dispose of live?.dispose ?? []) dispose();
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
          if (this.attachments) {
            await this.attachments.releaseExternal(c);
            await releaseExternalCaptures(this.deps.kernel, c.id);
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
    clearInterval(this.idleTimer);
    await Promise.all([...this.inputAdmissions.keys()].map(id => this.drainInputAdmissions(id)));
    for (const preparation of this.attachmentPreparations.values()) preparation.controller.abort(new Error('Application Host is stopping'));
    this.removeChildrenListener?.();
    for (const task of this.childTasks.values()) task.controller.abort();
    for (const controller of this.connectionControllers.values())
      controller.abort(new Error('Application Host is stopping'));
    // Start native termination before joining tasks that may themselves be
    // waiting for an unresponsive cancel acknowledgement from those peers.
    const closing = Promise.allSettled(
      [...this.connections.values()].map((live) => live.connection.close()),
    );
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled([...this.reclaiming.values()]);
    if (this.sweeping) await this.sweeping;
    await Promise.allSettled([...this.cacheWrites]);
    const results = await closing;
    await Promise.allSettled([...this.childTasks.values()].map((task) => task.work));
    await Promise.allSettled([...this.running.values()]);
    if (this.cleanupWork) await this.cleanupWork;
    for (const live of this.connections.values()) for (const dispose of live.dispose) dispose();
    this.connections.clear();
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length) throw new AggregateError(errors, 'External Agent shutdown did not complete');
  }
}
