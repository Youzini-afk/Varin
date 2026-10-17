import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import type { SpawnOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { requireAppliedProcessInteraction } from "./process-interaction.js";
import { ManagedProcessLaunchError, type ManagedPipedProcessHandle, type ManagedProcessIdentity, type ManagedProcessAdmission } from "../process/types.js";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import type { KernelClient, KernelGrantHandle, KernelScopedClient, KernelProcessSubscription } from "./kernel-client.js";
import type { KernelMethodParams, KernelProcessSnapshot, KernelProcessStreamEvent } from "./protocol.generated.js";

export type NativeProcessIdentity = ManagedProcessIdentity;
interface Options {
  client: KernelClient;
  resolveIdentity(cwd: string): Promise<NativeProcessIdentity>;
  onError?: (error: Error) => void;
}
export interface ProcessAddress { workspaceId: string; processId: string; rootId?: string }
type Address = ProcessAddress;
interface ProjectionOptions {
  retainOutput?: boolean;
  stdinIgnored?: boolean;
  terminate?: (force: boolean) => Promise<void>;
  /** Private Host protocols release an input after its final acknowledgement. */
  releaseInputReceipt?: (operationId: string) => Promise<unknown>;
}
export type ProcessProjectionClient = Pick<KernelScopedClient, 'processSubscribe' | 'processWrite' | 'processResize' | 'processKill' | 'processRelease'>;
const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));
const nativeSignal = (value: string | null): NodeJS.Signals | null => {
  if (!value) return null;
  const name = value.startsWith("SIG") ? value : "SIG" + value.toUpperCase();
  return Object.hasOwn(os.constants.signals, name) ? name as NodeJS.Signals : null;
};
function validateSnapshot(value: KernelProcessSnapshot, address: Address, epoch: string): void {
  if (value.processId !== address.processId || value.workspaceId !== address.workspaceId || value.kernelEpoch !== epoch
      || !["starting", "running", "exited", "failed", "unknown", "released"].includes(value.status)
      || typeof value.writerActive !== "boolean" || typeof value.outputAvailable !== "boolean"
      || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))) {
    throw new Error("Native process response identity or state is invalid");
  }
}

/** One local stream projection of one kernel handle. It never owns an OS child. */
export class KernelManagedProcess extends EventEmitter implements ManagedPipedProcessHandle {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;
  private current: KernelProcessSnapshot;
  private cursor = 0;
  private outputFailure: Error | null = null;
  private lost: Error | null = null;
  private subscriptionStart: Promise<void> | undefined;
  private subscription: KernelProcessSubscription | undefined;
  private pendingDataAck: (() => Promise<void>) | null = null;
  private endCursor = 0;
  private outputComplete = false;
  private ready = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private finishing = false;
  private releasePromise: Promise<void> | undefined;
  private stopRequested = false;
  private closed = false;
  private ignoreOutput = false;
  private readonly epoch: string;
  private replayEnd: number | undefined;

  constructor(private readonly scoped: ProcessProjectionClient, readonly address: Address, initial: KernelProcessSnapshot,
    private readonly reportError: (error: Error) => void, private readonly released: () => void,
    private readonly options: ProjectionOptions = {}) {
    super();
    this.current = initial;
    this.epoch = initial.kernelEpoch;
    this.completion = new Promise<void>((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; });
    this.readyPromise = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.completion.catch(() => undefined);
    void this.readyPromise.catch(() => undefined);
    this.stdout = new Readable({ read: () => { queueMicrotask(() => this.maybeAcknowledgeData()); }, highWaterMark: 64 * 1024 });
    this.stderr = new Readable({ read: () => { queueMicrotask(() => this.maybeAcknowledgeData()); }, highWaterMark: 64 * 1024 });
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => { void this.writeBytes(Buffer.from(chunk), false).then(() => done(), (error: unknown) => done(asError(error))); },
      final: (done) => { if (this.options.stdinIgnored) done(); else void this.writeBytes(Buffer.alloc(0), true).then(() => done(), (error: unknown) => done(asError(error))); },
      highWaterMark: 64 * 1024,
    });
    // Consumers can observe errors, but a broken pipe must not crash the Host.
    // A broken write channel invalidates the protocol using this process even
    // when its OS tree is still alive. Consumers must reject pending RPCs;
    // reporting only to a log leaves every later frame waiting on a dead pipe.
    this.stdin.on("error", (error) => this.emit("error", error));
    this.stdout.on("error", (error) => this.reportError(error));
    this.stderr.on("error", (error) => this.reportError(error));
    this.on("error", (error: Error) => this.reportError(error));
  }
  get pid(): number | undefined { return this.current.pid ?? undefined; }
  get exitCode(): number | null { return this.current.exitCode; }
  get signalCode(): NodeJS.Signals | null { return nativeSignal(this.current.signal); }
  get exitConfirmed(): boolean { return this.finishing && !this.current.writerActive; }
  get killed(): boolean { return this.stopRequested; }
  get snapshot(): KernelProcessSnapshot { return { ...this.current }; }
  get replayCursor(): number { return this.replayEnd ?? 0; }
  ownedBy(scoped: KernelScopedClient): boolean { return this.scoped === scoped; }

  async start(): Promise<void> {
    this.subscriptionStart ??= this.startSubscription();
    await this.subscriptionStart;
    return this.readyPromise;
  }
  private async startSubscription(): Promise<void> {
    try {
      const subscription = await this.scoped.processSubscribe({ ...this.address, cursor: this.cursor }, (event, acknowledge) => this.receive(event, acknowledge));
      this.subscription = subscription;
      void subscription.closed.catch((error: unknown) => this.invalidate(asError(error)));
      if (this.closed || this.lost) await subscription.close().catch((error: unknown) => this.reportError(asError(error)));
    } catch (error) { this.invalidate(asError(error)); throw error; }
  }
  invalidate(error: Error): void {
    if (this.closed || this.lost || this.exitConfirmed) return;
    this.lost = error;
    this.pendingDataAck = null;
    void this.subscription?.close().catch((failure: unknown) => this.reportError(asError(failure)));
    const stopped = !this.current.writerActive;
    if (!stopped) {
      this.current = { ...this.current, status: "unknown", writerActive: true, reason: "Native process connection was lost; exit is unconfirmed" };
    }
    this.readyReject(error);
    this.rejectCompletion(error);
    this.emit("error", error);
    this.stdin.destroy(error);
    this.stdout.destroy(error);
    this.stderr.destroy(error);
    if (stopped) {
      // A lost log stream cannot invalidate the already observed native tree receipt.
      // Completion still rejects: unread output was not successfully delivered.
      this.finishing = true;
      this.closed = true;
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
      if (this.options.retainOutput) this.released();
    }
    // Without prior tree evidence there is no synthetic exit/close or writer release.
  }
  private receive(event: KernelProcessStreamEvent, acknowledge: () => Promise<void>): void {
    if (this.closed || this.lost) return;
    try {
      if (!Number.isSafeInteger(event.replayCursor) || event.replayCursor < 0
        || this.replayEnd !== undefined && event.replayCursor !== this.replayEnd) throw new Error('Native process replay boundary changed');
      this.replayEnd = event.replayCursor;
      if (event.stream === "closed") throw new Error(event.error ?? "Native process subscription closed");
      const result = event.result;
      if (!result || !Array.isArray(result.chunks) || !Number.isSafeInteger(result.endCursor) || !Number.isSafeInteger(result.nextCursor)
        || result.endCursor < 0 || result.nextCursor < 0 || !Number.isSafeInteger(result.inputSequence) || result.inputSequence < -1
        || (result.inputError !== null && typeof result.inputError !== "string") || typeof result.outputComplete !== "boolean"
        || (result.outputError !== null && typeof result.outputError !== "string")) throw new Error("Native process stream result is malformed");
      this.endCursor = Math.max(this.endCursor, result.endCursor);
      if (event.stream === "control") {
        if (result.chunks.length !== 0) throw new Error("Native control event included output bytes");
        validateSnapshot(result.process, this.address, this.epoch);
        this.current = result.process;
        this.outputComplete = result.outputComplete;
        if (result.outputError !== null && this.outputFailure === null) {
          this.outputFailure = new Error(result.outputError); this.emit("error", this.outputFailure);
        }
        if (!this.ready && (this.current.pid !== null || (this.options.retainOutput && !this.current.writerActive && this.current.outputAvailable))) { this.ready = true; this.readyResolve(); }
        if (!this.current.writerActive && !this.ready) this.readyReject(new Error(this.current.reason ?? "Native process failed to start"));
            // Control credit is independent of Readable capacity and data acknowledgement.
        void acknowledge().catch((error: unknown) => this.invalidate(asError(error)));
        if (this.current.status === "unknown") throw new Error(this.current.reason ?? "Native process exit remains unknown");
      } else {
        if (this.pendingDataAck !== null) throw new Error("Native process exceeded its data credit");
        if (result.nextCursor <= this.cursor) throw new Error("Native process data stream made no progress");
        for (const chunk of result.chunks) {
          if (chunk.offset !== this.cursor || (chunk.channel !== "stdout" && chunk.channel !== "stderr")) throw new Error("Native output cursor or channel is invalid");
          const bytes = Buffer.from(chunk.bytesBase64, "base64");
          this.cursor += bytes.length;
          if (!this.ignoreOutput) (chunk.channel === "stdout" ? this.stdout : this.stderr).push(bytes);
        }
        if (this.cursor !== result.nextCursor) throw new Error("Native process output cursor did not match its bytes");
        this.pendingDataAck = acknowledge;
        this.maybeAcknowledgeData();
      }
      this.maybeFinish();
    } catch (error) { this.invalidate(asError(error)); }
  }
  private maybeAcknowledgeData(): void {
    if (this.closed || this.lost || this.pendingDataAck === null) return;
    if (!this.ignoreOutput && (this.stdout.readableLength >= 128 * 1024 || this.stderr.readableLength >= 128 * 1024)) return;
    const acknowledge = this.pendingDataAck; this.pendingDataAck = null;
    void acknowledge().catch((error: unknown) => this.invalidate(asError(error)));
  }
  private maybeFinish(): void {
    if (this.finishing || this.closed || this.lost || this.current.writerActive || this.cursor !== this.endCursor
      || (!this.outputComplete && this.outputFailure === null)) return;
    this.finishing = true; this.pendingDataAck = null;
    this.stdout.push(null); this.stderr.push(null);
    this.emit("exit", this.exitCode, this.signalCode);
    void (async () => {
      await this.subscription?.close().catch((error: unknown) => this.reportError(asError(error)));
      if (!this.options.retainOutput) await this.release().catch((error: unknown) => this.reportError(asError(error)));
      else this.released();
      this.closed = true; this.emit("close", this.exitCode, this.signalCode);
      if (this.outputFailure) this.rejectCompletion(this.outputFailure); else this.resolveCompletion();
    })();
  }
  writeInput(data: string, operationId?: string): Promise<void> { return this.writeBytes(Buffer.from(data), false, operationId); }
  private async writeBytes(bytes: Buffer, eof: boolean, identity?: string): Promise<void> {
    await this.readyPromise;
    if (this.lost) throw this.lost;
    if (this.options.stdinIgnored || this.finishing || this.stopRequested || !this.current.writerActive) throw new Error("Native process input is closed");
    const operationId = identity ?? `process-input:${randomUUID()}`;
    const receipt = await this.scoped.processWrite({ ...this.address, operationId,
      bytesBase64: bytes.toString("base64"), ...(eof ? { eof: true } : {}) });
    requireAppliedProcessInteraction(receipt, { ...this.address, operationId, kernelEpoch: this.epoch,
      kind: 'write', requestedBytes: bytes.length, eofRequested: eof });
    // Private pipe frames have no later receipt reader after this acknowledgement.
    // Caller-supplied operation IDs keep their durable replay contract.
    if (!identity) await this.releaseAcknowledgedInput(operationId);
  }
  private async releaseAcknowledgedInput(operationId: string): Promise<void> {
    try { await this.options.releaseInputReceipt?.(operationId); }
    catch (error) { this.reportError(asError(error)); }
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.lost) { this.emit("error", this.lost); return false; }
    if (this.exitConfirmed) return false;
    void this.requestTermination(signal === "SIGKILL" || signal === 9).catch((error: unknown) => this.emit("error", asError(error)));
    return true;
  }
  async requestTermination(force = false): Promise<void> {
    if (this.lost) throw this.lost;
    if (this.exitConfirmed) return;
    if (this.options.terminate) await this.options.terminate(force);
    else await this.scoped.processKill({ ...this.address, force });
    this.stopRequested = true;
  }
  async resize(cols: number, rows: number): Promise<void> {
    if (this.lost) throw this.lost;
    const operationId = `process-resize:${randomUUID()}`;
    const receipt = await this.scoped.processResize({ ...this.address, operationId, cols, rows });
    requireAppliedProcessInteraction(receipt, { ...this.address, operationId, kernelEpoch: this.epoch, kind: 'resize', cols, rows });
    await this.releaseAcknowledgedInput(operationId);
  }
  async release(): Promise<void> {
    if (this.options.retainOutput) throw new Error("Retained Agent process output belongs to its original operation");
    if (!this.exitConfirmed) throw new Error("Native process exit is unconfirmed; handle is retained");
    if (!this.releasePromise) {
      this.releasePromise = this.scoped.processRelease(this.address).then(() => { this.released(); });
      void this.releasePromise.catch(() => { this.releasePromise = undefined; });
    }
    await this.releasePromise;
  }
  /** Disposes a retained viewing projection without stopping the original job or deleting its output. */
  async detach(): Promise<void> {
    if (!this.options.retainOutput) throw new Error("Only retained process projections can detach");
    this.closed = true;
    this.pendingDataAck = null;
    const detached = new Error("Retained process view detached; the original job is unchanged");
    this.readyReject(detached); this.rejectCompletion(detached);
    try { await this.subscription?.close(); }
    finally { this.stdout.destroy(); this.stderr.destroy(); this.stdin.destroy(); this.released(); }
  }
  discardOutput(): void {
    this.ignoreOutput = true;
    this.stdout.resume(); this.stderr.resume();
  }
}

/** Terminal projection of the same process handle; no shell is launched here. */
export function projectProcessTerminal(child: KernelManagedProcess, options: { replayHistory?: boolean } = {}) {
  const decoder = new StringDecoder("utf8");
  const events = new EventEmitter();
  const pending: Array<{ data: string; replay: boolean }> = [];
  let outputCursor = 0;
  const emitData = (data: string, replay: boolean) => {
    if (!data) return;
    if (attached) events.emit('data', data, { replay }); else pending.push({ data, replay });
  };
  let attached = false;
  let outputEnded = child.stdout.readableEnded;
  let exited: { exitCode: number | null; signal: number } | undefined = child.exitConfirmed
    ? { exitCode: child.exitCode, signal: child.signalCode ? os.constants.signals[child.signalCode] : 0 } : undefined;
  let resolveExit!: () => void;
  const delivered = new Promise<void>(resolve => { resolveExit = resolve; });
  const completion = Promise.all([child.completion, delivered]).then(() => undefined);
  void completion.catch(() => undefined);
  let exitDelivered = false;
  const deliverExit = () => {
    if (!outputEnded || !exited || exitDelivered) return;
    exitDelivered = true;
    const remaining = decoder.end();
    emitData(remaining, options.replayHistory === true && outputCursor <= child.replayCursor);
    events.emit("exit", exited);
    resolveExit();
  };
  child.stdout.on("data", (bytes: Buffer) => {
    const replayLength = options.replayHistory ? Math.min(bytes.length, Math.max(0, child.replayCursor - outputCursor)) : 0;
    if (replayLength) emitData(decoder.write(bytes.subarray(0, replayLength)), true);
    if (replayLength < bytes.length) emitData(decoder.write(bytes.subarray(replayLength)), false);
    outputCursor += bytes.length;
  });
  child.stdout.on("end", () => {
    outputEnded = true;
    deliverExit();
  });
  child.stderr.resume();
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    exited = { exitCode: code, signal: signal ? os.constants.signals[signal] : 0 };
    deliverExit();
  });
  deliverExit();
  return {
    native: true as const,
    get pid() { return child.pid; },
    kill: (signal?: NodeJS.Signals) => { child.kill(signal); },
    terminate: (force = false) => child.requestTermination(force),
    completion,
    resize: (cols: number, rows: number) => child.resize(cols, rows),
    write: (data: string, operationId?: string) => child.writeInput(data, operationId),
    detach: () => child.detach(),
    onData(handler: (data: string, delivery?: { replay: boolean }) => void) {
      events.on("data", handler);
      attached = true;
      for (const entry of pending.splice(0)) handler(entry.data, { replay: entry.replay });
      return { dispose: () => { events.off("data", handler); } };
    },
    onExit(handler: (event: { exitCode: number | null; signal: number }) => void) {
      events.on("exit", handler);
      let active = true;
      if (exitDelivered && exited) queueMicrotask(() => { if (active) handler(exited!); });
      return { dispose: () => { active = false; events.off("exit", handler); } };
    },
  };
}

export function createKernelProcessService(options: Options) {
  const handles = new Set<KernelManagedProcess>();
  const launches = new Set<Promise<KernelManagedProcess>>();
  const grants = new Map<string, Promise<{ grant: KernelGrantHandle; client: KernelScopedClient; rootId: string; identity: NativeProcessIdentity; launches: Set<symbol>; retiring: boolean }>>();
  let stopping = false;
  const report = (error: Error): void => { try { options.onError?.(error); } catch { /* diagnostics are not process facts */ } };
  const unsubscribe = options.client.subscribeExit((error) => {
    stopping = true;
    for (const handle of handles) handle.invalidate(error);
  });
  const context = async (cwd: string, admission?: ManagedProcessAdmission, signal = new AbortController().signal) => {
    const resolvedIdentity = admission ? await admission(signal) : await options.resolveIdentity(cwd);
    const identity = {
      ...resolvedIdentity,
      canonicalRoot: await canonicalizePathIdentity(resolvedIdentity.canonicalRoot),
    };
    const key = JSON.stringify(identity);
    let existing = grants.get(key);
    if (!existing) {
      existing = (async () => {
        const grant = await options.client.issueGrant({
          grantId: "process-host:" + randomUUID(),
          owningWorkspace: identity.workspaceId, executionWorkspace: identity.executionWorkspaceId,
          capabilities: ["storage.read", "storage.write", "process", "process.maintenance"], pathScopes: [""],
        });
        const client = options.client.scoped(grant);
        const root = await client.fileRootRegister({ workspaceId: identity.workspaceId, executionWorkspaceId: identity.executionWorkspaceId, canonicalRoot: identity.canonicalRoot });
        if (typeof root.rootId !== "string") throw new Error("Native process root registration returned no identity");
        return { grant, client, rootId: root.rootId, identity, launches: new Set<symbol>(), retiring: false };
      })();
      grants.set(key, existing);
      void existing.catch(() => { grants.delete(key); });
    }
    return existing;
  };
  const launch = async (command: string, args: readonly string[], input: SpawnOptions, mode: "pipe" | "pty", cols = 80, rows = 24, admission?: ManagedProcessAdmission): Promise<KernelManagedProcess> => {
    input.signal?.throwIfAborted();
    if (stopping || !options.client.isReady) throw new Error("Native process authority is unavailable or stopping");
    if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) throw new Error("Native process launch requires an admitted absolute cwd");
    if (input.shell || input.detached || input.uid !== undefined || input.gid !== undefined) throw new Error("Native process launch does not accept an alternate shell, detached identity, uid or gid");
    const canonicalCwd = await canonicalizePathIdentity(input.cwd);
    const resolved = await context(input.cwd, admission, input.signal);
    if (stopping || resolved.retiring) throw new Error("Native process authority is stopping");
    const token = Symbol('process launch');
    resolved.launches.add(token);
    try {
    const cwd = path.relative(resolved.identity.canonicalRoot, canonicalCwd).replaceAll("\\", "/");
    if (cwd === ".." || cwd.startsWith("../") || path.isAbsolute(cwd)) throw new Error("Native process cwd is outside its admitted root");
    input.signal?.throwIfAborted();
    const stdinIgnored = mode === 'pipe' && (input.stdio === 'ignore' || Array.isArray(input.stdio) && input.stdio[0] === 'ignore');
    const params: KernelMethodParams["process.spawn"] = {
      processId: "process:" + randomUUID(), workspaceId: resolved.identity.workspaceId, rootId: resolved.rootId,
      cwd, command, args: [...args], mode, cols, rows, stdinMode: stdinIgnored ? 'null' : 'pipe',
      env: Object.entries(input.env ?? process.env).flatMap(([name, value]) => value === undefined || name === "NODE_CHANNEL_FD" ? [] : [{ name, value }]),
    };
    // The trusted source callback belongs to the original source owner, not the JSON
    // caller. Preparation/grant creation may have waited; re-admit at actual spawn.
    if (admission) {
      const current = await admission(input.signal ?? new AbortController().signal);
      if (current.workspaceId !== resolved.identity.workspaceId || current.executionWorkspaceId !== resolved.identity.executionWorkspaceId
        || await canonicalizePathIdentity(current.canonicalRoot) !== resolved.identity.canonicalRoot) throw new Error('Process source changed before launch');
    }
    input.signal?.throwIfAborted();
    const initial = await resolved.client.processSpawn(params);
    const epoch = options.client.kernelEpoch;
    if (!epoch) throw new Error("Native process epoch was lost during startup");
    validateSnapshot(initial, params, epoch);
    const handle = new KernelManagedProcess(resolved.client, { workspaceId: params.workspaceId, processId: params.processId }, initial, report, () => { handles.delete(handle); }, {
      stdinIgnored, releaseInputReceipt: operationId => resolved.client.releaseOperation(operationId),
    });
    handles.add(handle);
    try {
      await handle.start();
      if (stopping || input.signal?.aborted) {
        handle.discardOutput();
        await handle.requestTermination(true);
        await handle.completion;
        input.signal?.throwIfAborted();
        throw new Error('Native process launch was stopped before handoff');
      }
    } catch (error) {
      throw new ManagedProcessLaunchError(handle, error);
    }
    const stdio = input.stdio;
    if (stdio === "ignore") handle.discardOutput();
    if (stdinIgnored) handle.stdin.end();
    const onAbort = () => { handle.kill(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void handle.completion.finally(() => input.signal?.removeEventListener("abort", onAbort)).catch(() => undefined);
    if (input.signal?.aborted) onAbort();
    return handle;
    } finally { resolved.launches.delete(token); }
  };
  const trackedLaunch: typeof launch = (...args) => {
    const pending = launch(...args);
    launches.add(pending);
    void pending.finally(() => launches.delete(pending)).catch(() => undefined);
    return pending;
  };
  return {
    spawn: (command: string, args: readonly string[], input: SpawnOptions) => trackedLaunch(command, args, input, "pipe"),
    /** Release one drained private source context. It cannot revoke other roots
     * or a context still owned by an admitted process or in-flight launch. */
    async releaseContext(identity: NativeProcessIdentity): Promise<void> {
      const key = JSON.stringify(identity);
      const pending = grants.get(key);
      if (!pending) return;
      const context = await pending;
      if (context.launches.size) throw new Error('Source process context still has an active launch');
      const active = [...handles].filter(handle => handle.ownedBy(context.client));
      if (active.some(handle => !handle.exitConfirmed)) throw new Error('Source process context still has an unconfirmed writer');
      // The native grant retirement checks every persisted process under this
      // exact context, including a spawn already committed before handle handoff.
      context.retiring = true;
      let cursor = 0;
      for (;;) {
        const page = await context.client.processList({ workspaceId: identity.workspaceId, rootId: context.rootId, cursor });
        if (page.processes.some(process => process.writerActive)) throw new Error('Source process context has an unstopped native writer');
        if (page.nextCursor === null) break;
        if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor) throw new Error('Invalid native process continuation during context release');
        cursor = page.nextCursor;
      }
      await options.client.retireGrant(context.grant.grantId);
      if (grants.get(key) === pending) grants.delete(key);
    },
    /** Host-private source admission. Never exposed in process tool JSON or extension contracts. */
    spawnAdmitted: (admission: ManagedProcessAdmission, command: string, args: readonly string[], input: SpawnOptions) =>
      trackedLaunch(command, args, input, "pipe", 80, 24, admission),
    ptyProvider: {
      backend: "rust-kernel",
      async spawn(command: string, args: string[], input: Record<string, unknown>) {
        const child = await trackedLaunch(command, args, { cwd: String(input.cwd ?? ""), env: input.env as NodeJS.ProcessEnv }, "pty", Number(input.cols ?? 80), Number(input.rows ?? 24));
        return projectProcessTerminal(child);
      },
    },
    async list(cwd: string): Promise<KernelProcessSnapshot[]> {
      const resolved = await context(cwd);
      const result: KernelProcessSnapshot[] = [];
      let cursor = 0;
      for (;;) {
        const page = await resolved.client.processList({ workspaceId: resolved.identity.workspaceId, rootId: resolved.rootId, cursor });
        result.push(...page.processes);
        if (page.nextCursor === null) return result;
        if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor) throw new Error('Invalid native process list continuation');
        cursor = page.nextCursor;
      }
    },
    async dispose(): Promise<void> {
      if (stopping && !options.client.isReady) { unsubscribe(); return; }
      stopping = true;
      await Promise.allSettled([...launches]);
      const active = [...handles];
      for (const handle of active) handle.discardOutput();
      const requests = await Promise.allSettled(active.map((handle) => handle.requestTermination(true)));
      for (const request of requests) if (request.status === "rejected") report(asError(request.reason));
      const refused = requests.find((result) => result.status === "rejected");
      if (refused?.status === "rejected") throw asError(refused.reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exits = await Promise.race([
        Promise.allSettled(active.map((handle) => handle.completion)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native process exit is unconfirmed; writers remain retained")), 5000); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      unsubscribe();
      const failed = exits.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw asError(failed.reason);
      await Promise.all(active.map((handle) => handle.release()));
      await Promise.all([...grants.values()].map(async (pending) => options.client.revokeGrant((await pending).grant.grantId)));
      grants.clear();
    },
  };
}
export type KernelProcessService = ReturnType<typeof createKernelProcessService>;
