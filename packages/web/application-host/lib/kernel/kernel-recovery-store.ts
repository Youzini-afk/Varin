import { randomUUID } from "node:crypto";
import type {
  WorkspaceRecoveryCheckpointSummary,
  WorkspaceRecoveryEntryBindingResult,
  WorkspaceRecoveryEntryTarget,
  WorkspaceRecoveryMutationAfterInput,
  WorkspaceRecoveryMutationBeforeInput,
  WorkspaceRecoveryTurnBinding,
  WorkspaceRecoveryTurnSettledInput,
  WorkspaceRecoveryTurnStartInput,
} from "@varin/extension-contract";
import type {
  CapturedState,
  CaptureStateOptions,
  RecoveryFileStore,
  RecoveryIdentity,
  RecoveryState,
} from "../recovery/journal-files.js";
import { normalizeResourceId, parseRecoveryState, sameState } from "../recovery/journal-files.js";
import type {
  DurableRecoveryChangeSelection,
  WorkspaceRecoveryEngine,
  WorkspaceRecoveryStorageContext,
  RecoveryDurableOperationPort,
} from "../recovery/journal-engine.js";
import type { HostResourceOperationGate, ResolveDirectoryApplyContext } from "../recovery/durable-file-operation.js";
import { KernelFileResourceBackend } from "./file-resource-backend.js";
import type { KernelFileAuthorityContext, KernelStorageAdapter, KernelStorageContext, KernelStorageReference } from "./storage-adapter.js";
import type { KernelScopedClient } from "./kernel-client.js";

interface ScopedRecoveryActor {
  client: KernelScopedClient;
  identity: RecoveryIdentity;
  root: string;
  threadId: string;
  runId?: string;
  metadataReader?: Pick<RecoveryDurableOperationPort, "listOperations">;
}

const asObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const recoveryIdentity = (workspaceId: string, canonicalRoot: string): RecoveryIdentity => ({
  authorityId: "kernel",
  canonicalRoot,
  filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`,
  workspaceId,
});

export class KernelRecoveryContentStore implements RecoveryFileStore {
  private readonly owners = new Map<string, Set<string>>();
  private readonly sources = new Map<string, Array<{ workspaceId: string; recordId: string; slot: string }>>();
  readonly fileResources: KernelFileResourceBackend;

  constructor(
    private readonly adapter: KernelStorageAdapter,
    fileResourcesOrLegacyCacheRoot?: KernelFileResourceBackend | string,
    private readonly scopedActor?: ScopedRecoveryActor,
  ) {
    this.fileResources = fileResourcesOrLegacyCacheRoot instanceof KernelFileResourceBackend
      ? fileResourcesOrLegacyCacheRoot
      : new KernelFileResourceBackend(adapter, {
          authorityPurpose: "recovery-maintenance",
          authorityCapabilities: ["recovery.maintenance"],
        });
  }

  private key(workspaceId: string, hash: string): string {
    return `${workspaceId}\0${hash}`;
  }

  registerRecord(workspaceId: string, recordId: string, reference: KernelStorageReference): void {
    const key = this.key(workspaceId, reference.objectHash);
    const sources = this.sources.get(key) ?? [];
    if (!sources.some((source) => source.recordId === recordId && source.slot === reference.slot)) {
      sources.push({ workspaceId, recordId, slot: reference.slot });
      this.sources.set(key, sources);
    }
  }

  ownerIdForHash(workspaceId: string, hash: string): string | undefined {
    return this.owners.get(this.key(workspaceId, hash))?.values().next().value;
  }

  registerObjectOwner(workspaceId: string, hash: string, ownerId: string): void {
    if (this.scopedActor && workspaceId !== this.scopedActor.identity.workspaceId) {
      throw new Error("Recovery object owner belongs to another admitted workspace");
    }
    const key = this.key(workspaceId, hash);
    const owners = this.owners.get(key) ?? new Set<string>();
    owners.add(ownerId);
    this.owners.set(key, owners);
  }

  consumeOwner(ownerId: string): void {
    for (const [key, owners] of this.owners) {
      if (!owners.delete(ownerId)) continue;
      if (owners.size === 0) this.owners.delete(key);
      return;
    }
  }

  private async objectBytes(workspaceId: string, hash: string, sessionId?: string): Promise<Buffer> {
    if (this.scopedActor && (workspaceId !== this.scopedActor.identity.workspaceId || sessionId)) {
      throw new Error("Recovery object access does not match its admitted actor");
    }
    const context = this.scopedActor ?? await this.adapter.context(
      workspaceId,
      sessionId ? "recovery-actor" : "recovery-maintenance",
      sessionId
        ? { owningWorkspace: workspaceId, executionWorkspace: workspaceId, sessionId, pathScopes: [""] }
        : { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance"] },
    );
    const candidates: Array<{ ownerId: string } | { recordId: string; slot: string }> = [
      ...[...(this.owners.get(this.key(workspaceId, hash)) ?? [])].map((ownerId) => ({ ownerId })),
      ...(this.sources.get(this.key(workspaceId, hash)) ?? []).map(({ recordId, slot }) => ({ recordId, slot })),
    ];
    let lastError: unknown;
    for (const source of candidates) {
      try {
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const slice = await context.client.getBlob(hash, source, { offset, length: 256 * 1024 });
          chunks.push(Buffer.from(slice.bytesBase64, "base64"));
          if (slice.eof) return Buffer.concat(chunks);
          if (slice.nextOffset <= offset) throw new Error(`Kernel recovery object cursor did not advance: ${hash}`);
          offset = slice.nextOffset;
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Kernel recovery object source is unknown: ${hash}`);
  }

  async captureState(
    identity: RecoveryIdentity,
    _root: string,
    inputPath: string,
    options: CaptureStateOptions = {},
    _sessionId?: string,
  ): Promise<CapturedState> {
    if (this.scopedActor && (identity.workspaceId !== this.scopedActor.identity.workspaceId || _sessionId)) {
      throw new Error("Recovery capture does not match its admitted actor");
    }
    const captured = await this.fileResources.captureDetailed(
      identity,
      inputPath,
      options,
      `recovery-capture:${identity.workspaceId}:${randomUUID()}`,
    );
    if (captured.ownerId && captured.state.kind === "regular-file") {
      // File capture can belong to a nested execution-directory grant. Recovery
      // metadata still belongs to the owning workspace's record writer: transfer
      // the transient owner to that exact grant, also for maintenance operations.
      const recordWriter = this.scopedActor ?? await this.adapter.context(identity.workspaceId,
        _sessionId ? "recovery-actor" : "recovery-maintenance", {
          owningWorkspace: identity.workspaceId,
          executionWorkspace: identity.workspaceId,
          ...(_sessionId ? { sessionId: _sessionId } : { capabilities: ["recovery.maintenance"] }),
          pathScopes: [""],
        });
      if (!this.scopedActor) await recordWriter.client.rebindObjectOwner(identity.workspaceId, captured.ownerId);
      const key = this.key(identity.workspaceId, captured.state.objectHash);
      const owners = this.owners.get(key) ?? new Set<string>();
      owners.add(captured.ownerId);
      this.owners.set(key, owners);
    }
    return { path: captured.path, state: captured.state };
  }

  async applyState(identity: RecoveryIdentity, _root: string, relativePath: string, state: RecoveryState): Promise<void> {
    const result = await this.fileResources.applyStateDetailed(identity, relativePath, state);
    if (result.status === "conflict") {
      throw new Error(`Kernel file apply conflicted after resource admission: ${relativePath}`);
    }
  }

  hashFile(filePath: string) {
    return this.fileResources.hashFile(filePath);
  }

  relativePathFor(identity: RecoveryIdentity, inputPath: string) {
    return this.fileResources.relativePathFor(identity, inputPath);
  }

  integrationConflicts: RecoveryDurableOperationPort["listOperationConflicts"] = input => this.fileResources.integrationConflicts(
    recoveryIdentity(input.workspaceId, input.canonicalRoot), input.paths, input.exceptOperationId);

  resourceOperationGate(identity: RecoveryIdentity): HostResourceOperationGate {
    return this.fileResources.gateFor(identity);
  }

  async verifyObject(_root: string, state: RecoveryState): Promise<void> {
    if (state.kind !== "regular-file") return;
    const suffix = `\0${state.objectHash}`;
    const workspaces = new Set<string>();
    for (const [key, sources] of this.sources) {
      if (key.endsWith(suffix)) for (const source of sources) workspaces.add(source.workspaceId);
    }
    for (const key of this.owners.keys()) {
      if (key.endsWith(suffix)) workspaces.add(key.slice(0, key.indexOf("\0")));
    }
    let lastError: unknown;
    for (const workspaceId of workspaces) {
      try {
        const bytes = await this.objectBytes(workspaceId, state.objectHash);
        if (bytes.byteLength !== state.byteLength) {
          throw new Error(`Kernel recovery object length mismatch: ${state.objectHash}`);
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Kernel recovery object source is unknown: ${state.objectHash}`);
  }
}

export interface KernelRecoveryContentStoreLike {
  registerObjectOwner?(workspaceId: string, hash: string, ownerId: string): void;
  captureState(
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    options?: CaptureStateOptions,
    sessionId?: string,
  ): Promise<CapturedState>;
  registerRecord(workspaceId: string, recordId: string, reference: KernelStorageReference): void;
  ownerIdForHash(workspaceId: string, hash: string): string | undefined;
  consumeOwner(ownerId: string): void;
  resourceOperationGate?(identity: RecoveryIdentity): HostResourceOperationGate;
  integrationConflicts?: RecoveryDurableOperationPort["listOperationConflicts"];
}

export class KernelRecoveryStore {
  constructor(
    private readonly adapter: KernelStorageAdapter,
    readonly content: KernelRecoveryContentStoreLike,
    private readonly scopedActor?: ScopedRecoveryActor,
  ) {}

  registerObjectOwner(workspaceId: string, hash: string, ownerId: string): void {
    if (!this.content.registerObjectOwner) throw new Error("Recovery candidate object registration is unavailable");
    this.content.registerObjectOwner(workspaceId, hash, ownerId);
  }

  private context(workspaceId: string, sessionId?: string, maintenance = false): Promise<Pick<KernelStorageContext, "client" | "identity" | "root">> {
    if (this.scopedActor) {
      if (workspaceId !== this.scopedActor.identity.workspaceId || sessionId) {
        throw new Error("Recovery operation does not match its admitted actor");
      }
      return Promise.resolve(this.scopedActor);
    }
    return this.adapter.context(
      workspaceId,
      maintenance ? "recovery-maintenance" : "recovery-actor",
      maintenance
        ? { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance"] }
        : { owningWorkspace: workspaceId, executionWorkspace: workspaceId, ...(sessionId ? { sessionId } : {}), pathScopes: [""] },
    );
  }

  private summary(value: Record<string, unknown>): WorkspaceRecoveryCheckpointSummary {
    return {
      id: String(value.id),
      workspaceId: String(value.workspaceId),
      sequence: Number(value.sequence),
      source: value.source as WorkspaceRecoveryCheckpointSummary["source"],
      state: value.state as WorkspaceRecoveryCheckpointSummary["state"],
      createdAt: String(value.createdAt),
      ...(typeof value.label === "string" ? { label: value.label } : {}),
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
      ...(typeof value.executionId === "string" ? { executionId: value.executionId } : {}),
      changedPathCount: Number(value.changedPathCount ?? 0),
      byteLength: Number(value.byteLength ?? 0),
    };
  }

  private turn(payload: Record<string, unknown>): WorkspaceRecoveryTurnBinding {
    return {
      activeWriterScopes: Array.isArray(payload.activeWriterScopes) ? payload.activeWriterScopes as string[] : [],
      checkpointId: String(payload.checkpointId),
      executionId: String(payload.executionId),
      provenance: payload.provenance as WorkspaceRecoveryTurnBinding["provenance"],
      runtimeGeneration: Number(payload.runtimeGeneration),
      runtimeKey: String(payload.runtimeKey),
      sessionId: String(payload.sessionId),
      startedAt: String(payload.startedAt),
      status: payload.status as WorkspaceRecoveryTurnBinding["status"],
      unrecordedResourceIds: Array.isArray(payload.unrecordedResourceIds) ? payload.unrecordedResourceIds as string[] : [],
      userEntryId: String(payload.userEntryId),
      workerId: String(payload.workerId),
      workspaceId: String(payload.workspaceId),
      ...(typeof payload.assistantEntryId === "string" ? { assistantEntryId: payload.assistantEntryId } : {}),
      ...(payload.failure && typeof payload.failure === "object" ? { failure: payload.failure as NonNullable<WorkspaceRecoveryTurnBinding["failure"]> } : {}),
      ...(typeof payload.settledAt === "string" ? { settledAt: payload.settledAt } : {}),
    };
  }

  async recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBinding> {
    const context = await this.context(input.workspaceId, input.sessionId);
    const value = await context.client.recoveryTurnStart({
      operationId: `recovery-turn-start:${input.workspaceId}:${input.executionId}`,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      userEntryId: input.userEntryId,
      workerId: input.workerId,
      runtimeGeneration: input.runtimeGeneration,
      activeWriterScopes: [...input.activeWriterScopes],
      provenance: input.provenance,
      ...(input.failure === undefined ? {} : { failure: Boolean(input.failure) }),
    });
    return this.turn(value);
  }

  async listCheckpoints(workspaceId: string): Promise<WorkspaceRecoveryCheckpointSummary[]> {
    const context = await this.context(workspaceId, undefined, true);
    const result: WorkspaceRecoveryCheckpointSummary[] = [];
    let cursor: number | undefined;
    do {
      const value = await context.client.recoveryCheckpointList({
        workspaceId,
        pageSize: 512,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (Array.isArray(value.checkpoints)) {
        result.push(...value.checkpoints.map((item) => this.summary(asObject(item))));
      }
      cursor = typeof value.nextCursor === "number" ? value.nextCursor : undefined;
    } while (cursor !== undefined);
    return result.sort((a, b) => b.sequence - a.sequence);
  }

  async createNamedCheckpoint(workspaceId: string, name: string): Promise<WorkspaceRecoveryCheckpointSummary> {
    const context = await this.context(workspaceId, undefined, true);
    return this.summary(await context.client.recoveryCheckpointCreate({
      operationId: `recovery-checkpoint:${workspaceId}:${randomUUID()}`,
      workspaceId,
      label: name,
    }));
  }

  async resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult> {
    const context = await this.context(input.workspaceId, input.sessionId);
    const value = await context.client.recoveryEntryResolve({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      entryId: input.entryId,
    });
    if (typeof value.executionId !== "string") return value as unknown as WorkspaceRecoveryEntryBindingResult;
    const turn = await context.client.recoveryTurnGet({
      workspaceId: input.workspaceId,
      executionId: value.executionId,
      sessionId: input.sessionId,
    });
    const binding = turn ? this.turn(turn) : undefined;
    const checkpointValue = value.checkpoint;
    const checkpoint = checkpointValue && typeof checkpointValue === "object"
      ? this.summary(asObject(checkpointValue))
      : undefined;
    return { ...value, ...(binding ? { binding } : {}), ...(checkpoint ? { checkpoint } : {}) } as WorkspaceRecoveryEntryBindingResult;
  }

  async recordMutationBefore(input: WorkspaceRecoveryMutationBeforeInput): Promise<boolean> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const turn = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!turn || typeof turn.sessionId !== "string") return false;
    const context = await this.context(input.workspaceId, turn.sessionId);
    const captured = await this.content.captureState(
      recoveryIdentity(input.workspaceId, context.identity.canonicalRoot),
      context.root,
      input.path,
      { store: true },
      turn.sessionId,
    );
    const ownerId = captured.state.kind === "regular-file"
      ? this.content.ownerIdForHash(input.workspaceId, captured.state.objectHash)
      : undefined;
    const references = captured.state.kind === "regular-file"
      ? [{ slot: "before", objectHash: captured.state.objectHash, ...(ownerId ? { ownerId } : {}) }]
      : [];
    try {
      const result = await context.client.recoveryChangeBefore({
        operationId: `recovery-before:${input.executionId}:${input.mutationId}:${captured.path}`,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId: String(turn.checkpointId),
        path: captured.path,
        toolName: input.toolName,
        mutationId: input.mutationId,
        beforeJson: JSON.stringify(captured.state),
        references,
      });
      if (ownerId && result.existing === true) await context.client.releaseBlob(ownerId).catch(() => undefined);
    } catch (error) {
      if (ownerId) await context.client.releaseBlob(ownerId).catch(() => undefined);
      if (ownerId) this.content.consumeOwner(ownerId);
      throw error;
    }
    if (ownerId) this.content.consumeOwner(ownerId);
    for (const reference of references) {
      this.content.registerRecord(input.workspaceId, `change:${String(turn.checkpointId)}:${captured.path}`, reference);
    }
    return true;
  }

  async recordMutationAfter(input: WorkspaceRecoveryMutationAfterInput): Promise<boolean> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const turn = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!turn || typeof turn.sessionId !== "string") return false;
    const context = await this.context(input.workspaceId, turn.sessionId);
    const checkpointId = String(turn.checkpointId);
    const captured = await this.content.captureState(
      recoveryIdentity(input.workspaceId, context.identity.canonicalRoot),
      context.root,
      input.path,
      { store: true },
      turn.sessionId,
    );
    const capturedOwner = captured.state.kind === "regular-file"
      ? this.content.ownerIdForHash(input.workspaceId, captured.state.objectHash)
      : undefined;
    const prior = await context.client.recoveryChangeGet({
      workspaceId: input.workspaceId,
      checkpointId,
      path: captured.path,
    });
    if (!prior) {
      if (capturedOwner) await context.client.releaseBlob(capturedOwner).catch(() => undefined);
      if (capturedOwner) this.content.consumeOwner(capturedOwner);
      return false;
    }
    const before = asObject(prior.before) as unknown as RecoveryState;
    const operationId = `recovery-after:${input.executionId}:${input.mutationId}:${captured.path}`;
    if (sameState(before, captured.state)) {
      await context.client.recoveryChangeAfter({
        operationId,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId,
        path: captured.path,
        afterJson: JSON.stringify(captured.state),
        succeeded: false,
        expectedRevision: Number(prior.revision),
        references: [],
      });
      if (capturedOwner) await context.client.releaseBlob(capturedOwner).catch(() => undefined);
      if (capturedOwner) this.content.consumeOwner(capturedOwner);
      return false;
    }
    const references = [
      ...(before.kind === "regular-file" ? [{ slot: "before", objectHash: before.objectHash }] : []),
      ...(captured.state.kind === "regular-file"
        ? [{ slot: "after", objectHash: captured.state.objectHash, ...(capturedOwner ? { ownerId: capturedOwner } : {}) }]
        : []),
    ];
    try {
      await context.client.recoveryChangeAfter({
        operationId,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId,
        path: captured.path,
        afterJson: JSON.stringify(captured.state),
        succeeded: input.succeeded,
        expectedRevision: Number(prior.revision),
        references,
      });
    } catch (error) {
      if (capturedOwner) await context.client.releaseBlob(capturedOwner).catch(() => undefined);
      if (capturedOwner) this.content.consumeOwner(capturedOwner);
      throw error;
    }
    if (capturedOwner) this.content.consumeOwner(capturedOwner);
    for (const reference of references) {
      this.content.registerRecord(input.workspaceId, `change:${checkpointId}:${captured.path}`, reference);
    }
    return true;
  }

  async recordIntegrationChanges(input: {
    workspaceId: string;
    executionId: string;
    operationId: string;
    changes: Record<string, { before: RecoveryState; after: RecoveryState }>;
  }): Promise<boolean> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const turn = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!turn || (turn.status !== "pending" && turn.status !== "ready") || typeof turn.sessionId !== "string" || typeof turn.checkpointId !== "string") return false;
    const context = await this.context(input.workspaceId, turn.sessionId);
    const checkpointId = turn.checkpointId;
    if (turn.status === "ready") {
      for (const [rawPath, states] of Object.entries(input.changes)) {
        const path = normalizeResourceId(rawPath);
        const prior = await context.client.recoveryChangeGet({ workspaceId: input.workspaceId, checkpointId, path });
        if (!prior || !prior.after || !sameState(parseRecoveryState(prior.after), states.after)) return false;
      }
      return true;
    }
    const refs = (before: RecoveryState, after?: RecoveryState) => [
      ...(before.kind === "regular-file" ? [{ slot: "before", objectHash: before.objectHash }] : []),
      ...(after?.kind === "regular-file" ? [{ slot: "after", objectHash: after.objectHash }] : []),
    ];
    for (const [rawPath, states] of Object.entries(input.changes).sort(([left], [right]) => left.localeCompare(right))) {
      const path = normalizeResourceId(rawPath);
      if (!path) throw new Error("Integration recovery change path is empty");
      const beforeResult = await context.client.recoveryChangeBefore({
        operationId: `integration-before:${input.operationId}:${path}`,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId,
        path,
        toolName: "thread.merge",
        mutationId: `thread.merge:${input.operationId}:${path}`,
        beforeJson: JSON.stringify(states.before),
        references: refs(states.before),
      });
      const prior = await context.client.recoveryChangeGet({ workspaceId: input.workspaceId, checkpointId, path });
      if (!prior) throw new Error(`Integration recovery before-image disappeared: ${path}`);
      const priorAfter = prior.after && typeof prior.after === "object"
        ? parseRecoveryState(prior.after)
        : undefined;
      if (priorAfter && sameState(priorAfter, states.after)) continue;
      await context.client.recoveryChangeAfter({
        operationId: `integration-after:${input.operationId}:${path}`,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId,
        path,
        afterJson: JSON.stringify(states.after),
        succeeded: true,
        expectedRevision: Number(prior.revision ?? beforeResult.revision ?? 1),
        references: refs(parseRecoveryState(prior.before), states.after),
      });
      for (const reference of refs(parseRecoveryState(prior.before), states.after)) {
        this.content.registerRecord(input.workspaceId, `change:${checkpointId}:${path}`, reference);
      }
    }
    return true;
  }

  async recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBinding> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const row = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!row || typeof row.sessionId !== "string") throw new Error("checkpoint-missing");
    const context = await this.context(input.workspaceId, row.sessionId);
    const listed = await context.client.recoveryChangeList({
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      sessionId: row.sessionId,
    });
    const changes = Array.isArray(listed.changes) ? listed.changes : [];
    const recorded = changes.flatMap((value) => {
      const item = asObject(value);
      return typeof item.path === "string" ? [normalizeResourceId(item.path)] : [];
    });
    const comparison = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
    const recordedKeys = new Set(recorded.map(comparison));
    const observed = [...new Set(input.observedResourceIds
      .map(normalizeResourceId)
      .filter((value): value is string => Boolean(value) && !/\.varin-(?:tmp|restore|recovery)-/u.test(value)))].sort();
    const unrecorded = observed.filter((value) => !recordedKeys.has(comparison(value)));
    const retainedFailure = row.status === "incomplete" && row.failure && typeof row.failure === "object"
      ? row.failure as Record<string, unknown>
      : undefined;
    const exact = !input.failure
      && !retainedFailure
      && (!input.mutationObserved || input.observationComplete)
      && unrecorded.length === 0
      && !(input.mutationObserved && recorded.length === 0 && observed.length === 0);
    const failure = input.failure ?? retainedFailure ?? (exact ? undefined : {
      code: "checkpoint-incomplete",
      message: unrecorded.length > 0
        ? `Some changed paths were not captured before mutation: ${unrecorded.join(", ")}`
        : "Workspace activity was observed outside the exact write/edit journal",
      origin: "coverage",
      retryable: false,
      ...(unrecorded.length > 0 ? { details: { paths: unrecorded } } : {}),
    });
    const settled = await context.client.recoveryTurnSettle({
      operationId: `recovery-settle:${input.executionId}`,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      expectedRevision: Number(row.revision),
      status: exact ? "ready" : "incomplete",
      observedResourceIds: observed,
      unrecordedResourceIds: unrecorded,
      observationComplete: input.observationComplete,
      activeWriterScopes: [...input.activeWriterScopes],
      provenance: input.provenance,
      ...(input.assistantEntryId ? { assistantEntryId: input.assistantEntryId } : {}),
      ...(failure ? { failureJson: JSON.stringify(failure) } : {}),
    });
    return this.turn(settled);
  }

  async listChanges(input: {
    workspaceId: string;
    sessionId?: string;
    executionId?: string;
    entryIds?: string[];
  }): Promise<DurableRecoveryChangeSelection> {
    const context = await this.context(input.workspaceId, undefined, true);
    const raw = await context.client.recoveryChangeList(input);
    const changes = (Array.isArray(raw.changes) ? raw.changes : []).map((value) => {
      const item = asObject(value);
      const before = parseRecoveryState(item.before);
      const after = parseRecoveryState(item.after);
      const recordId = `change:${String(item.checkpointId)}:${String(item.path)}`;
      if (before.kind === "regular-file") this.content.registerRecord(input.workspaceId, recordId, { slot: "before", objectHash: before.objectHash });
      if (after.kind === "regular-file") this.content.registerRecord(input.workspaceId, recordId, { slot: "after", objectHash: after.objectHash });
      return {
        after,
        before,
        checkpointId: String(item.checkpointId),
        executionId: String(item.executionId),
        mutationId: String(item.mutationId),
        path: String(item.path),
        sequence: Number(item.sequence),
        toolName: String(item.toolName),
      };
    });
    const turns = (Array.isArray(raw.turns) ? raw.turns : []).map((value) => {
      const item = asObject(value);
      return {
        activeWriterScopes: Array.isArray(item.activeWriterScopes) ? item.activeWriterScopes as string[] : [],
        checkpointId: String(item.checkpointId),
        executionId: String(item.executionId),
        sequence: Number(item.sequence),
        status: String(item.status),
        unrecordedResourceIds: Array.isArray(item.unrecordedResourceIds) ? item.unrecordedResourceIds as string[] : [],
        ...(item.failure && typeof item.failure === "object" ? { failure: item.failure as Record<string, unknown> } : {}),
      };
    });
    return { changes, turns };
  }

  private stateReferences(
    workspaceId: string,
    value: unknown,
    prefix: string,
  ): Array<{ slot: string; objectHash: string; ownerId?: string }> {
    const output: Array<{ slot: string; objectHash: string; ownerId?: string }> = [];
    const visit = (entry: unknown, slot: string): void => {
      if (!entry || typeof entry !== "object") return;
      if (Array.isArray(entry)) {
        entry.forEach((child, index) => visit(child, `${slot}[${index}]`));
        return;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.objectHash === "string" && /^sha256-[0-9a-f]{64}$/u.test(record.objectHash)) {
        const ownerId = this.content.ownerIdForHash(workspaceId, record.objectHash);
        output.push({ slot, objectHash: record.objectHash, ...(ownerId ? { ownerId } : {}) });
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== "objectHash") visit(child, slot ? `${slot}.${key}` : key);
      }
    };
    visit(value, prefix);
    return output;
  }

  async createOperation(input: {
    operationId: string;
    workspaceId: string;
    kind: string;
    state: string;
    data: Record<string, unknown>;
    targets: Record<string, { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState }>;
    sessionId?: string;
    threadId?: string;
    runId?: string;
    surfacePaths?: readonly string[];
  }): Promise<Record<string, unknown>> {
    if (this.scopedActor) {
      if (input.sessionId || (input.threadId && input.threadId !== this.scopedActor.threadId)
        || (input.runId && input.runId !== this.scopedActor.runId)) {
        throw new Error("Recovery operation owner does not match its admitted actor");
      }
      input = { ...input, threadId: this.scopedActor.threadId,
        ...(this.scopedActor.runId ? { runId: this.scopedActor.runId } : {}) };
    }
    const context = await this.context(input.workspaceId, undefined, true);
    const surfacePaths = new Set(input.surfacePaths ?? []);
    const files = Object.entries(input.targets).map(([filePath, states]) => ({
      path: filePath,
      ...(surfacePaths.has(filePath) ? {} : states.expected ? { expectedJson: JSON.stringify(states.expected) } : {}),
      ...(surfacePaths.has(filePath) ? {} : states.target ? { targetJson: JSON.stringify(states.target) } : {}),
      ...(surfacePaths.has(filePath) ? {} : states.safety ? { safetyJson: JSON.stringify(states.safety) } : {}),
      phase: "pending",
      references: surfacePaths.has(filePath) ? [] : this.stateReferences(input.workspaceId, states, filePath),
    }));
    const result = await context.client.recoveryOperationCreate({
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      state: input.state,
      dataJson: JSON.stringify(input.data),
      files,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });
    for (const file of files) {
      for (const reference of file.references) {
        if (reference.ownerId) this.content.consumeOwner(reference.ownerId);
        this.content.registerRecord(input.workspaceId, `operation-file:${input.operationId}:${file.path}`, reference);
      }
    }
    return result;
  }

  async updateOperationFile(input: {
    operationId: string;
    workspaceId: string;
    path: string;
    expectedRevision: number;
    expectedPhase: string;
    phase: string;
    observedFingerprint?: string;
    expected?: RecoveryState;
    target?: RecoveryState;
    safety?: RecoveryState;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const context = await this.context(input.workspaceId, undefined, true);
    const current = await context.client.recoveryOperationGet({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
    });
    if (!current) throw new Error(`Recovery operation not found: ${input.operationId}`);
    const currentFile = Array.isArray(current.files)
      ? current.files.find((entry) => asObject(entry).path === input.path)
      : undefined;
    if (!currentFile) throw new Error(`Recovery operation path not found: ${input.path}`);
    const row = asObject(currentFile);
    const parseState = (name: string): RecoveryState | undefined => (
      typeof row[name] === "string" ? JSON.parse(row[name] as string) as RecoveryState : undefined
    );
    const states = {
      expected: input.expected ?? parseState("expectedJson"),
      target: input.target ?? parseState("targetJson"),
      safety: input.safety ?? parseState("safetyJson"),
    };
    const references = this.stateReferences(input.workspaceId, states, input.path);
    const result = await context.client.recoveryOperationFileCas({
      transitionId: `recovery-file:${input.operationId}:${input.path}:${input.expectedRevision}:${input.expectedPhase}:${input.phase}`,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      path: input.path,
      expectedRevision: input.expectedRevision,
      expectedPhase: input.expectedPhase,
      phase: input.phase,
      ...(input.observedFingerprint ? { observedFingerprint: input.observedFingerprint } : {}),
      ...(input.expected ? { expectedJson: JSON.stringify(input.expected) } : {}),
      ...(input.target ? { targetJson: JSON.stringify(input.target) } : {}),
      ...(input.safety ? { safetyJson: JSON.stringify(input.safety) } : {}),
      references,
    });
    for (const reference of references) {
      if (reference.ownerId) this.content.consumeOwner(reference.ownerId);
      this.content.registerRecord(input.workspaceId, `operation-file:${input.operationId}:${input.path}`, reference);
    }
    return result;
  }

  async completeOperation(input: {
    operationId: string;
    workspaceId: string;
    expectedRevision: number;
    state: string;
    result?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const context = await this.context(input.workspaceId, undefined, true);
    return context.client.recoveryOperationComplete({
      transitionId: `recovery-complete:${input.operationId}:${input.expectedRevision}:${input.state}`,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      expectedRevision: input.expectedRevision,
      state: input.state,
      ...(input.result ? { resultJson: JSON.stringify(input.result) } : {}),
      ...(input.failure ? { failureJson: JSON.stringify(input.failure) } : {}),
    });
  }

  private registerOperationSources(workspaceId: string, operation: Record<string, unknown>): void {
    const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
    if (!operationId || !Array.isArray(operation.files)) return;
    for (const value of operation.files) {
      const file = asObject(value);
      if (typeof file.path !== "string") continue;
      const recordId = `operation-file:${operationId}:${file.path}`;
      for (const [field, name] of [["expectedJson", "expected"], ["targetJson", "target"], ["safetyJson", "safety"]] as const) {
        if (typeof file[field] !== "string") continue;
        const state = parseRecoveryState(JSON.parse(file[field] as string) as unknown);
        if (state.kind === "regular-file") {
          this.content.registerRecord(workspaceId, recordId, { slot: `${file.path}.${name}`, objectHash: state.objectHash });
        }
      }
    }
  }

  async getOperation(workspaceId: string, operationId: string, _sessionId?: string): Promise<Record<string, unknown> | null> {
    const context = await this.context(workspaceId, undefined, true);
    const operation = await context.client.recoveryOperationGet({ workspaceId, operationId });
    if (operation) this.registerOperationSources(workspaceId, operation);
    return operation;
  }

  async listOperations(workspaceId: string, kind?: string): Promise<Record<string, unknown>[]> {
    if (this.scopedActor) {
      if (workspaceId !== this.scopedActor.identity.workspaceId || !this.scopedActor.metadataReader) {
        throw new Error("Workspace operation inspection requires its explicit metadata reader");
      }
      return this.scopedActor.metadataReader.listOperations(workspaceId, kind);
    }
    const context = await this.context(workspaceId, undefined, true);
    const output: Record<string, unknown>[] = [];
    let cursor: number | undefined;
    do {
      const value = await context.client.recoveryOperationList({
        workspaceId,
        ...(kind ? { kind } : {}),
        pageSize: 512,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (Array.isArray(value.operations)) {
        output.push(...value.operations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
      }
      cursor = typeof value.nextCursor === "number" ? value.nextCursor : undefined;
    } while (cursor !== undefined);
    return output;
  }

  listOperationConflicts: RecoveryDurableOperationPort["listOperationConflicts"] = input => {
    if (!this.content.integrationConflicts) throw new Error("Recovery physical reservation inspection is unavailable");
    return this.content.integrationConflicts(input);
  };

  async releaseOperation(workspaceId: string, operationId: string): Promise<Record<string, unknown>> {
    const context = await this.context(workspaceId, undefined, true);
    return context.client.recoveryOperationRelease({
      transitionId: `recovery-release:${workspaceId}:${operationId}`,
      operationId,
      workspaceId,
    });
  }

  async workspaceStorageContext(
    workspaceId: string,
    options: {
      resourceOperationGate?: HostResourceOperationGate;
      resolveDirectoryApplyContext?: ResolveDirectoryApplyContext;
    } = {},
  ): Promise<WorkspaceRecoveryStorageContext> {
    if (this.scopedActor) {
      if (workspaceId !== this.scopedActor.identity.workspaceId || options.resolveDirectoryApplyContext) {
        throw new Error("Scoped recovery cannot resolve another execution directory");
      }
      const content = this.content;
      if (!(content instanceof KernelRecoveryContentStore)) throw new Error("Scoped recovery content store is unavailable");
      return { ...this.scopedActor, fileStore: content, fileResources: content.fileResources,
        resourceOperationGate: options.resourceOperationGate ?? content.resourceOperationGate(this.scopedActor.identity),
        durableRecoveryStore: this };
    }
    const context = await this.adapter.context(workspaceId, "recovery-maintenance", {
      owningWorkspace: workspaceId,
      executionWorkspace: workspaceId,
      pathScopes: [""],
      capabilities: ["recovery.maintenance"],
    });
    return {
      fileStore: context.fileStore,
      ...(this.content instanceof KernelRecoveryContentStore
        ? { fileResources: this.content.fileResources }
        : {}),
      identity: context.identity,
      resourceOperationGate: options.resourceOperationGate
        ?? this.content.resourceOperationGate?.(context.identity)
        ?? context.resourceOperationGate,
      root: context.root,
      ...(context.collectUnreachableObjects ? { collectUnreachableObjects: context.collectUnreachableObjects } : {}),
      durableRecoveryStore: this,
      ...(options.resolveDirectoryApplyContext ? { resolveDirectoryApplyContext: options.resolveDirectoryApplyContext } : {}),
      records: context.records,
    } as unknown as WorkspaceRecoveryStorageContext;
  }

  health() {
    return this.adapter.client.health();
  }
}

/** Reuses the original file/journal implementations with one admitted source authority. */
export const createScopedKernelRecoveryBindings = (
  adapter: KernelStorageAdapter,
  input: {
    authority: KernelFileAuthorityContext;
    threadId: string;
    runId?: string;
    storageRoot: string;
    /** Only an independent Host coordinator; never pass a second kernel gate for these same paths. */
    resourceOperationGate?: HostResourceOperationGate;
    metadataReader?: Pick<RecoveryDurableOperationPort, "listOperations">;
  },
) => {
  if (!input.threadId) throw new Error("Scoped recovery requires its real Thread owner");
  const identity = recoveryIdentity(input.authority.owningWorkspaceId, input.authority.canonicalRoot);
  const actor: ScopedRecoveryActor = { client: input.authority.client, identity, root: input.storageRoot,
    threadId: input.threadId, ...(input.runId ? { runId: input.runId } : {}),
    ...(input.metadataReader ? { metadataReader: input.metadataReader } : {}) };
  const fileResources = new KernelFileResourceBackend(adapter, { authority: input.authority });
  const fileStore = new KernelRecoveryContentStore(adapter, fileResources, actor);
  const durableRecoveryStore = new KernelRecoveryStore(adapter, fileStore, actor);
  const kernelGate = fileResources.gateFor(identity);
  const resourceOperationGate: HostResourceOperationGate = input.resourceOperationGate
    ? { run: (resources, operation, options) => input.resourceOperationGate!.run(resources,
      () => kernelGate.run(resources, operation, options), options) }
    : kernelGate;
  return { fileStore, fileResources, resourceOperationGate, durableRecoveryStore };
};

export const createKernelRecoveryDirectFacade = (
  base: WorkspaceRecoveryEngine,
  store: KernelRecoveryStore,
  options: {
    authorityId?: string;
    listWorkspaceRegistrations?: () => Promise<Array<{ canonicalPath: string; workspaceId: string }>>;
    resourceOperationGateFor?: (workspaceId: string) => HostResourceOperationGate;
    resolveDirectoryApplyContext?: ResolveDirectoryApplyContext;
  } = {},
): WorkspaceRecoveryEngine => {
  const facade = { ...base } as WorkspaceRecoveryEngine;
  facade.withWorkspaceStorage = (workspaceId, accessOptions, operation) => base.withWorkspaceStorage(workspaceId, accessOptions, async () => operation(
    await store.workspaceStorageContext(workspaceId, {
      ...(options.resourceOperationGateFor ? { resourceOperationGate: options.resourceOperationGateFor(workspaceId) } : {}),
      ...(options.resolveDirectoryApplyContext ? { resolveDirectoryApplyContext: options.resolveDirectoryApplyContext } : {}),
    }),
  ));
  facade.recordTurnStart = async (input) => ({ binding: await store.recordTurnStart(input), status: "ready" });
  facade.recordMutationBefore = async (input) => ({ recorded: await store.recordMutationBefore(input), status: "ready" });
  facade.recordMutationAfter = async (input) => ({ recorded: await store.recordMutationAfter(input), status: "ready" });
  facade.recordTurnSettled = async (input) => ({ binding: await store.recordTurnSettled(input), status: "ready" });
  facade.createCheckpoint = async (input) => ({ checkpoint: await store.createNamedCheckpoint(input.workspaceId, input.name), status: "ready" });
  facade.listCheckpoints = async (input) => {
    const checkpoints = await store.listCheckpoints(input.workspaceId);
    const found = input.cursor === undefined
      ? 0
      : checkpoints.findIndex((item) => item.sequence < input.cursor!);
    const start = found < 0 ? checkpoints.length : found;
    const page = checkpoints.slice(start, input.limit === undefined ? undefined : start + input.limit);
    return {
      page: {
        checkpoints: page,
        nextCursor: input.limit !== undefined && start + page.length < checkpoints.length
          ? page.at(-1)?.sequence ?? null
          : null,
      },
      status: "ready",
    };
  };
  facade.resolveEntry = (input) => store.resolveEntry(input);
  const unavailable = (message: string) => ({
    status: "failed" as const,
    failure: { code: "unavailable" as const, message, origin: "storage" as const, retryable: false },
  });
  const storageStatus = async (workspaceId?: string) => {
    const [health, checkpoints] = await Promise.all([
      store.health(),
      workspaceId ? store.listCheckpoints(workspaceId) : Promise.resolve([]),
    ]);
    const authorityId = options.authorityId
      ?? (workspaceId ? (await store.workspaceStorageContext(workspaceId)).identity.authorityId : "kernel");
    return {
      authorityId,
      scope: "host" as const,
      byteLength: Number(health.catalogBytes ?? 0) + Number(health.walBytes ?? 0),
      catalog: { currentSchemaVersion: 1, retiredCatalogCount: 0, state: "ready" as const },
      checkpointCount: checkpoints.length,
      encryption: { available: false, enabled: false },
      location: { mode: "application-data" as const },
      locationSource: "global" as const,
      objectCount: Number(health.blobs ?? 0),
      readyCheckpointCount: checkpoints.filter((checkpoint) => checkpoint.state === "ready").length,
      registryRevision: 1,
      state: "ready" as const,
      ...(workspaceId ? { workspaceId } : {}),
    };
  };
  facade.storageStatus = async (workspaceId) => ({ status: "ready", storage: await storageStatus(workspaceId) });
  facade.listStorageWorkspaces = async () => {
    const registrations = await options.listWorkspaceRegistrations?.() ?? [];
    const storage = await storageStatus();
    const workspaces = await Promise.all(registrations.map(async (registration) => {
      const [checkpoints, operations] = await Promise.all([
        store.listCheckpoints(registration.workspaceId),
        store.listOperations(registration.workspaceId),
      ]);
      if (checkpoints.length === 0 && operations.length === 0) return null;
      const lastActivityAt = [...checkpoints.map((checkpoint) => checkpoint.createdAt), ...operations.map((operation) => operation.updatedAt)]
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1) ?? null;
      return {
        canonicalRoot: registration.canonicalPath,
        catalog: storage.catalog,
        checkpointCount: checkpoints.length,
        lastActivityAt,
        location: storage.location,
        locationSource: storage.locationSource,
        migrationRequired: false,
        state: storage.state,
        storageAvailable: true,
        workspaceAvailable: true,
        workspaceId: registration.workspaceId,
      };
    }));
    return { status: "ready", workspaces: workspaces.filter((workspace) => workspace !== null) };
  };
  facade.retentionStatus = async (workspaceId) => ({
    status: "ready",
    retention: {
      eligibleCheckpointCount: 0,
      lastRunAt: null,
      oldestProtectedOperationAt: null,
      policy: { maxAgeDays: null, maxByteLength: null, maxCheckpointCount: null, maxOperationCount: null },
      protectedCheckpointCount: (await store.listCheckpoints(workspaceId)).length,
      protectedOperationCount: (await store.listOperations(workspaceId)).length,
      retainedByteLength: 0,
      terminalOperationCount: (await store.listOperations(workspaceId)).filter((operation) => ["complete", "aborted", "compensated", "undone"].includes(String(operation.state))).length,
      workspaceId,
    },
  });
  facade.setRetentionPolicy = async () => unavailable("Recovery retention policy is owned by the Rust kernel and is not configurable");
  facade.setDefaultStorageLocation = async () => unavailable("Rust recovery storage is fixed to the Application Host kernel data directory");
  facade.setStorageLocation = async () => unavailable("Rust recovery storage cannot be moved independently of kernel storage");
  facade.clearStorageLocationOverride = async () => unavailable("Rust recovery storage has no workspace location override");
  facade.getStorageMove = async () => unavailable("Rust recovery storage does not create standalone move operations");
  facade.cleanupStorage = async (input) => {
    const context = await store.workspaceStorageContext(input.workspaceId);
    if (!context.collectUnreachableObjects) return unavailable("Kernel object cleanup is unavailable");
    const collected = await context.collectUnreachableObjects();
    return {
      status: "ready",
      result: {
        byteLengthReclaimed: collected.byteLengthReclaimed,
        failures: [],
        objectsDeleted: collected.objectsDeleted,
        operationId: `kernel-recovery-gc:${input.workspaceId}:${randomUUID()}`,
        recordsDeleted: 0,
        status: "complete",
        workspaceId: input.workspaceId,
      },
    };
  };
  facade.deleteWorkspaceHistory = async () => unavailable("Deleting typed Rust recovery history is not available");
  facade.status = async (workspaceId) => {
    const context = await store.workspaceStorageContext(workspaceId);
    const attention = (await store.listOperations(workspaceId, "agent-mutation"))
      .filter((operation) => operation.state === "needs-attention");
    const retention = await facade.retentionStatus(workspaceId);
    if (retention.status !== "ready") return retention;
    return {
      status: "ready",
      capabilities: {
        bindings: true,
        catalogLifecycle: true,
        checkpoints: true,
        combined: true,
        conflictConfirmation: true,
        dirtyStateBarrier: true,
        journal: true,
        redo: true,
        retention: false,
        storageManagement: false,
        workspaceLease: false,
      },
      failures: attention.map((operation) => ({
        code: "needs-attention" as const,
        message: `Agent surface mutation ${String(operation.operationId)} requires attention`,
        operationId: String(operation.operationId),
        origin: "storage" as const,
        retryable: false,
      })),
      identity: context.identity,
      retention: retention.retention,
      storage: await storageStatus(workspaceId),
    } as never;
  };
  return facade;
};
