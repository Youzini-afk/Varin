import type {
  DocumentsAPI,
  VarinDirtyStateBarrierEvent,
  VarinDocumentSurfaceOperationEvent,
  VarinDocumentSurfaceOperationPayload,
  VarinDocumentSurfaceOperationResourceResult,
  VarinDocumentReadResult,
  VarinResourceReference,
  VarinWorkspaceFileEvent,
  Subscription,
} from '@varin/application-client';
import { DocumentsError } from '@varin/application-client';
import { parseAgentInputContext, type AgentInputContext } from '@varin/protocol';
import { peekAgentFileChangeHint } from '@/lib/agent-editor/hints';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { detectLineEnding, normalizeEditorLineEndings, serializeEditorContent } from './line-ending';
import { requireWorkspaceEpoch } from './mutation-token';
import { getDocumentRecoverySessionId } from './recovery-session';
import {
  documentKey,
  toDocumentMeta,
  type DocumentChange,
  type DocumentEditResult,
  type DocumentIdentity,
  type DocumentMeta,
  type DocumentRecord,
  type DocumentTextPosition,
  type DocumentWorkspaceEditApplyResult,
  type DocumentWorkspaceEditFailure,
  type DocumentWorkspaceEditInput,
  type DocumentWorkspaceEditPrepareResult,
  type DocumentWorkspaceEditPreview,
  type DocumentWorkspaceEditUndoResult,
  type DocumentWorkspaceTextEdit,
} from './types';

export type DocumentListener = (record: DocumentRecord) => void;

const EMPTY_RESOURCE_IDS: ReadonlySet<string> = new Set();

const bufferHash = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const replacementBetween = (previous: string, next: string): DocumentChange | null => {
  if (previous === next) return null;
  let from = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (from < sharedLength && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > from
    && nextEnd > from
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return { from, to: previousEnd, insert: next.slice(from, nextEnd) };
};

const endPosition = (content: string): DocumentTextPosition => {
  const lines = content.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

type PreparedWorkspaceDocument = {
  before: DocumentRecord;
  afterBuffer: string;
  changes: DocumentChange[];
  editCount: number;
  wasOpen: boolean;
};

type PreparedWorkspaceEdit = {
  generation: number;
  preview: DocumentWorkspaceEditPreview;
  documents: PreparedWorkspaceDocument[];
};

type WorkspaceEditUndoGroup = {
  groupId: string;
  documents: Array<{
    identity: DocumentIdentity;
    beforeBuffer: string;
    appliedBuffer: string;
    appliedRevision: number;
  }>;
};

type DirtyBarrierHold = {
  active: boolean;
  barrierId: string;
  caseSensitive: boolean;
  paths: Set<string>;
  release: () => void;
  released: Promise<void>;
  workspaceId: string;
};

const offsetAtPosition = (buffer: string, position: DocumentTextPosition): number | null => {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)
    || position.line < 0 || position.character < 0) return null;
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const newline = buffer.indexOf('\n', lineStart);
    if (newline < 0) return null;
    lineStart = newline + 1;
    line += 1;
  }
  const newline = buffer.indexOf('\n', lineStart);
  const lineEnd = newline < 0 ? buffer.length : newline;
  if (position.character > lineEnd - lineStart) return null;
  return lineStart + position.character;
};

const prepareTextChanges = (
  buffer: string,
  edits: readonly DocumentWorkspaceTextEdit[],
): { status: 'ready'; buffer: string; changes: DocumentChange[] } | { status: 'invalid-range' | 'overlapping-ranges' } => {
  const changes: Array<DocumentChange & { index: number }> = [];
  for (const [index, edit] of edits.entries()) {
    const from = offsetAtPosition(buffer, edit.range.start);
    const to = offsetAtPosition(buffer, edit.range.end);
    if (from === null || to === null || to < from) return { status: 'invalid-range' };
    changes.push({ from, to, insert: edit.newText, index });
  }
  const ascending = [...changes].sort((left, right) => (
    left.from - right.from || left.to - right.to || left.index - right.index
  ));
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index - 1].to > ascending[index].from) return { status: 'overlapping-ranges' };
  }
  const descending = [...changes]
    .sort((left, right) => right.from - left.from || right.to - left.to || right.index - left.index)
    .map(({ from, to, insert }) => ({ from, to, insert }));
  let next = buffer;
  for (const edit of descending) next = `${next.slice(0, edit.from)}${edit.insert}${next.slice(edit.to)}`;
  return { status: 'ready', buffer: next, changes: descending };
};

const sameResourceSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => (
  left.size === right.size && [...left].every((value) => right.has(value))
);

type RegistryOptions = {
  documents: DocumentsAPI;
  getGeneration?: () => number;
  recoverySessionId?: string;
  journalDebounceMs?: number;
  now?: () => number;
  createDocumentInstanceId?: () => string;
};

const emptyRecord = (
  identity: DocumentIdentity,
  generation: number,
  documentInstanceId: string,
): DocumentRecord => ({
  identity,
  documentInstanceId,
  connectionGeneration: generation,
  workspaceEpoch: 0,
  status: 'unloaded',
  dirty: false,
  saving: false,
  baseContent: '',
  buffer: '',
  baseRevision: null,
  localEditRevision: 0,
  encoding: 'utf-8',
  bom: false,
  lineEnding: 'lf',
  byteLength: 0,
  saveOperationId: null,
  saveCapturedEditRevision: null,
  conflict: null,
  errorMessage: null,
  recoveryJournalId: null,
  recoveryJournalRevision: null,
  lastOrigin: null,
  lastChanges: null,
  externalSource: null,
});

const applyRead = (record: DocumentRecord, result: VarinDocumentReadResult): DocumentRecord => {
  if (result.status === 'missing') {
    if (record.baseRevision !== null) {
      const ancestorContent = record.conflict?.ancestorContent ?? record.baseContent;
      const ancestorRevision = record.conflict?.ancestorRevision ?? record.baseRevision;
      return {
        ...record,
        status: 'deleted',
        workspaceEpoch: result.epoch,
        byteLength: 0,
        errorMessage: null,
        conflict: record.dirty
          ? {
              diskRevision: 'missing',
              ancestorContent,
              ancestorRevision,
              diskContent: '',
            }
          : null,
      };
    }
    return {
      ...record,
      status: 'missing',
      workspaceEpoch: result.epoch,
      baseContent: '',
      buffer: record.dirty ? record.buffer : '',
      baseRevision: null,
      byteLength: 0,
      errorMessage: null,
      conflict: null,
    };
  }
  if (result.status === 'binary') {
    return {
      ...record,
      status: 'binary',
      workspaceEpoch: result.epoch,
      baseRevision: result.revision,
      byteLength: result.byteLength,
      errorMessage: null,
      conflict: null,
    };
  }
  if (result.status === 'unsupported-encoding') {
    return {
      ...record,
      status: 'unsupported-encoding',
      workspaceEpoch: result.epoch,
      baseRevision: result.revision,
      byteLength: result.byteLength,
      errorMessage: null,
      conflict: null,
    };
  }
  const lineEnding = detectLineEnding(result.content);
  const normalized = normalizeEditorLineEndings(result.content);
  if (record.dirty && record.buffer === normalized) {
    return {
      ...record,
      status: 'ready',
      workspaceEpoch: result.epoch,
      dirty: false,
      baseContent: normalized,
      baseRevision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      lineEnding,
      byteLength: result.byteLength,
      conflict: null,
      errorMessage: null,
    };
  }
  if (record.dirty && record.buffer !== normalized) {
    const ancestorContent = record.conflict?.ancestorContent ?? record.baseContent;
    const ancestorRevision = record.conflict?.ancestorRevision ?? record.baseRevision;
    return {
      ...record,
      status: 'conflict',
      workspaceEpoch: result.epoch,
      baseContent: normalized,
      baseRevision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      lineEnding,
      byteLength: result.byteLength,
      conflict: {
        diskRevision: result.revision,
        ancestorContent,
        ancestorRevision,
        diskContent: normalized,
      },
      errorMessage: null,
    };
  }
  const externalChange = record.baseRevision !== null
    ? replacementBetween(record.buffer, normalized)
    : null;
  return {
    ...record,
    status: 'ready',
    workspaceEpoch: result.epoch,
    dirty: false,
    baseContent: normalized,
    buffer: normalized,
    localEditRevision: record.localEditRevision + (externalChange ? 1 : 0),
    baseRevision: result.revision,
    encoding: result.encoding,
    bom: result.bom,
    lineEnding,
    byteLength: result.byteLength,
    conflict: null,
    errorMessage: null,
    lastOrigin: externalChange ? 'disk' : record.lastOrigin,
    lastChanges: externalChange ? [externalChange] : record.lastChanges,
  };
};

export class DocumentRegistry {
  readonly recoverySessionId: string;
  private readonly documents: DocumentsAPI;
  private readonly getGeneration: () => number;
  private readonly journalDebounceMs: number;
  private readonly createDocumentInstanceId: () => string;
  private readonly records = new Map<string, DocumentRecord>();
  private readonly openOperations = new Map<string, Promise<DocumentRecord>>();
  private readonly listeners = new Map<string, Set<DocumentListener>>();
  private readonly coordinationByAlias = new Map<string, string>();
  private readonly aliasesByCoordination = new Map<string, Map<string, DocumentIdentity>>();
  private readonly availableAliases = new Set<string>();
  private readonly dirtyIdsByWorkspace = new Map<string, Set<string>>();
  private readonly dirtyListenersByWorkspace = new Map<string, Set<() => void>>();
  private readonly dirtyOwnerId: string;
  private readonly dirtyPublicationTails = new Map<string, Promise<void>>();
  private readonly workspaceListeners = new Map<string, Set<() => void>>();
  private readonly workspaceVersions = new Map<string, number>();
  private readonly watches = new Map<string, Subscription>();
  private readonly journalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly journalOperations = new Map<string, Promise<void>>();
  private readonly preparedWorkspaceEdits = new Map<string, PreparedWorkspaceEdit>();
  private readonly workspaceEditUndoGroups = new Map<string, WorkspaceEditUndoGroup>();
  private readonly dirtyBarriers = new Map<string, DirtyBarrierHold>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: RegistryOptions) {
    this.documents = options.documents;
    this.getGeneration = options.getGeneration ?? getRuntimeEndpointGeneration;
    this.recoverySessionId = options.recoverySessionId ?? getDocumentRecoverySessionId();
    this.dirtyOwnerId = `document-surface:${this.recoverySessionId}:${crypto.randomUUID()}`;
    this.journalDebounceMs = options.journalDebounceMs ?? 750;
    this.createDocumentInstanceId = options.createDocumentInstanceId ?? (() => crypto.randomUUID());
  }

  keyFor(identity: DocumentIdentity): string {
    if (identity.coordinationId) return identity.coordinationId;
    const alias = documentKey(identity);
    return this.coordinationByAlias.get(alias) ?? alias;
  }

  private aliasesFor(identity: DocumentIdentity): DocumentIdentity[] {
    return [...(this.aliasesByCoordination.get(this.keyFor(identity))?.values() ?? [identity])];
  }

  private availableAliasesFor(identity: DocumentIdentity): DocumentIdentity[] {
    return this.aliasesFor(identity).filter((alias) => this.availableAliases.has(`${alias.workspaceId}\0${alias.resourceId}`));
  }

  private async resolveIdentity(identity: DocumentIdentity): Promise<DocumentIdentity> {
    const alias = `${identity.workspaceId}\0${identity.resourceId}`;
    let coordinationId: string;
    let rootAliases: Array<{ workspaceId: string; resourceId: string }>;
    try {
      ({ coordinationId, aliases: rootAliases } = await this.documents.resolveResourceIdentity(identity));
    } catch (error) {
      const lastKnown = this.coordinationByAlias.get(alias);
      this.availableAliases.delete(alias);
      if (lastKnown && this.records.get(lastKnown)?.dirty) return { ...identity, coordinationId: lastKnown };
      throw error;
    }
    if (typeof coordinationId !== 'string' || !coordinationId || !Array.isArray(rootAliases)) {
      throw new DocumentsError('Document resource identity is unavailable', { reason: 'failed' });
    }
    const aliases = this.aliasesByCoordination.get(coordinationId) ?? new Map<string, DocumentIdentity>();
    const targets = new Map<string, DocumentIdentity>();
    for (const candidate of [...rootAliases, identity]) {
      if (!candidate || typeof candidate.workspaceId !== 'string' || typeof candidate.resourceId !== 'string') continue;
      targets.set(`${candidate.workspaceId}\0${candidate.resourceId}`, { ...candidate, coordinationId });
    }
    if (!targets.has(alias)) throw new DocumentsError('Document resource identity omitted its requested path', { reason: 'failed' });
    for (const aliasKey of aliases.keys()) {
      if (!targets.has(aliasKey)) this.availableAliases.delete(aliasKey);
    }
    for (const [aliasKey] of targets) {
      const prior = this.coordinationByAlias.get(aliasKey);
      if (prior && prior !== coordinationId && this.records.get(prior)?.dirty) {
        throw new DocumentsError('Document location changed while it has unsaved edits', { reason: 'stale-completion' });
      }
    }
    const newlyMapped = new Set<string>();
    const newlyAvailable = new Set<string>();
    for (const [aliasKey, resolvedAlias] of targets) {
      const prior = this.coordinationByAlias.get(aliasKey);
      if (!prior || prior !== coordinationId) newlyMapped.add(aliasKey);
      if (!this.availableAliases.has(aliasKey)) newlyAvailable.add(aliasKey);
      if (prior && prior !== coordinationId) this.aliasesByCoordination.get(prior)?.delete(aliasKey);
      this.coordinationByAlias.set(aliasKey, coordinationId);
      aliases.set(aliasKey, resolvedAlias);
      this.availableAliases.add(aliasKey);
    }
    this.aliasesByCoordination.set(coordinationId, aliases);
    const record = this.records.get(coordinationId);
    for (const [aliasKey, resolvedAlias] of targets) {
      if (record?.dirty) this.updateDirtyIndexAlias(resolvedAlias, true);
      if (record?.dirty && newlyAvailable.has(aliasKey)) void this.publishDirtyWorkspace(resolvedAlias.workspaceId);
      const pending = this.listeners.get(aliasKey);
      if (newlyMapped.has(aliasKey) && pending && record) for (const listener of pending) {
        try { listener(record); } catch (error) { this.reportJournalFailure(error); }
      }
    }
    return targets.get(alias)!;
  }

  get(identity: DocumentIdentity): DocumentRecord | undefined {
    return this.records.get(this.keyFor(identity));
  }

  meta(identity: DocumentIdentity): DocumentMeta | undefined {
    const record = this.get(identity);
    return record ? toDocumentMeta(record) : undefined;
  }

  subscribe(identity: DocumentIdentity, listener: DocumentListener): () => void {
    const key = `${identity.workspaceId}\0${identity.resourceId}`;
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      const current = this.listeners.get(key);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(key);
    };
  }

  subscribeDirty(workspaceId: string, listener: () => void): () => void {
    const listeners = this.dirtyListenersByWorkspace.get(workspaceId) ?? new Set();
    listeners.add(listener);
    this.dirtyListenersByWorkspace.set(workspaceId, listeners);
    return () => {
      const current = this.dirtyListenersByWorkspace.get(workspaceId);
      current?.delete(listener);
      if (current?.size === 0) this.dirtyListenersByWorkspace.delete(workspaceId);
    };
  }

  subscribeWorkspace(workspaceId: string, listener: () => void): () => void {
    const listeners = this.workspaceListeners.get(workspaceId) ?? new Set();
    listeners.add(listener);
    this.workspaceListeners.set(workspaceId, listeners);
    return () => {
      const current = this.workspaceListeners.get(workspaceId);
      current?.delete(listener);
      if (current?.size === 0) this.workspaceListeners.delete(workspaceId);
    };
  }

  workspaceVersion(workspaceId: string): number {
    return this.workspaceVersions.get(workspaceId) ?? 0;
  }

  dirtyResourceIds(workspaceId: string): ReadonlySet<string> {
    return this.dirtyIdsByWorkspace.get(workspaceId) ?? EMPTY_RESOURCE_IDS;
  }

  surfaceOwner(): { generation: number; ownerId: string } {
    return { generation: this.getGeneration(), ownerId: this.dirtyOwnerId };
  }

  async captureAgentInputContext(sessionId: string): Promise<AgentInputContext> {
    this.assertActive();
    const generation = this.getGeneration();
    const dirtyBuffers = [...this.records.values()].filter((record) => record.dirty);
    if (dirtyBuffers.length === 0) return { source: 'disk' };
    const knownRecords = dirtyBuffers.flatMap((record) => this.aliasesFor(record.identity)
      .map((alias) => ({ record, alias })));
    const rootsOf = (entries: typeof knownRecords) => [...new Set(entries.map(({ alias }) => alias.workspaceId))].map((workspaceId) => ({
      workspaceId,
      dirtyPaths: entries.filter(({ alias }) => alias.workspaceId === workspaceId).map(({ alias }) => alias.resourceId),
    }));
    const unavailable = (entries: typeof knownRecords): AgentInputContext => ({
      source: 'surface',
      roots: rootsOf(entries),
      snapshot: { status: 'unavailable', reason: 'surface-unavailable' },
    });
    // Registered aliases can go offline between editor operations. Recheck the
    // physical identity once per dirty buffer so an unavailable secondary root
    // neither blocks a valid source nor makes a different target inherit it.
    const verifiedRecords = await Promise.all(dirtyBuffers.map(async (record): Promise<typeof knownRecords | null> => {
      let verified: VarinResourceReference[] | null = null;
      for (const alias of this.aliasesFor(record.identity)) {
        try {
          const result = await this.documents.resolveResourceIdentity(alias);
          if (result.coordinationId === this.keyFor(record.identity)) {
            verified = result.aliases;
            break;
          }
        } catch { /* Another known alias may still address this buffer. */ }
      }
      if (!verified) return null;
      const unique = new Map(verified.map((alias) => [`${alias.workspaceId}\0${alias.resourceId}`, alias]));
      return [...unique.values()].map((alias) => ({ record, alias }));
    }));
    if (verifiedRecords.some((entries) => entries === null)
      || this.disposed || generation !== this.getGeneration()
      || dirtyBuffers.some((record) => this.records.get(this.keyFor(record.identity)) !== record)) {
      return unavailable(knownRecords);
    }
    const dirtyRecords: typeof knownRecords = verifiedRecords.flatMap((entries) => entries ?? []);
    dirtyRecords.sort((left, right) => left.alias.workspaceId.localeCompare(right.alias.workspaceId)
      || left.alias.resourceId.localeCompare(right.alias.resourceId));
    const roots = rootsOf(dirtyRecords);
    if (!this.documents.captureAgentInputSnapshot) return unavailable(dirtyRecords);
    const resources = await Promise.all(dirtyRecords.map(async ({ record, alias }) => ({
      baseRevision: record.baseRevision,
      bufferHash: await bufferHash(record.buffer),
      documentInstanceId: record.documentInstanceId,
      encoding: record.encoding,
      bom: record.bom,
      lineEnding: record.lineEnding,
      content: serializeEditorContent(record.buffer, record.lineEnding),
      localEditRevision: record.localEditRevision,
      resource: { workspaceId: alias.workspaceId, resourceId: alias.resourceId },
    })));
    if (this.disposed || generation !== this.getGeneration()
      || dirtyBuffers.some((record) => this.records.get(this.keyFor(record.identity)) !== record)) {
      return unavailable(dirtyRecords);
    }
    try {
      await Promise.all(roots.map(async ({ workspaceId }) => {
        this.ensureWatch(workspaceId);
        await this.enqueueDirtyPublication(workspaceId, generation, resources
          .filter((entry) => entry.resource.workspaceId === workspaceId)
          .map(({ content: _content, ...resource }) => resource));
      }));
      if (this.disposed || generation !== this.getGeneration()) return unavailable(dirtyRecords);
      const captured = parseAgentInputContext(await this.documents.captureAgentInputSnapshot({
        generation,
        ownerId: this.dirtyOwnerId,
        resources,
        sessionId,
      }));
      if (!captured || captured.source !== 'surface'
        || captured.snapshot.status !== 'ready'
        || captured.roots.length !== roots.length
        || roots.some((root) => {
          const actual = captured.roots.find((entry) => entry.workspaceId === root.workspaceId);
          return !actual || !sameResourceSet(new Set(actual.dirtyPaths), new Set(root.dirtyPaths));
        })) return unavailable(dirtyRecords);
      return captured;
    } catch {
      return unavailable(dirtyRecords);
    }
  }

  async releaseAgentInputContext(sessionId: string, context: AgentInputContext): Promise<void> {
    if (context.source !== 'surface' || context.snapshot.status !== 'ready') return;
    await this.documents.releaseAgentInputSnapshot?.({ context, sessionId });
  }

  private barrierPath(value: string, caseSensitive: boolean): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
    return caseSensitive ? normalized : normalized.toLowerCase();
  }

  private isDirtyBarrierHeld(identity: DocumentIdentity): boolean {
    return [...this.dirtyBarriers.values()].some((barrier) => (
      barrier.active
      && this.aliasesFor(identity).some((alias) => (
        barrier.workspaceId === alias.workspaceId
        && barrier.paths.has(this.barrierPath(alias.resourceId, barrier.caseSensitive))
      ))
    ));
  }

  private assertDirtyBarrierAllowsEdit(identity: DocumentIdentity): void {
    if (!this.isDirtyBarrierHeld(identity)) return;
    throw new DocumentsError('Document is temporarily fenced while workspace recovery is applied', {
      reason: 'failed',
    });
  }

  open(identity: DocumentIdentity, options?: { reload?: boolean }): Promise<DocumentRecord> {
    return this.resolveIdentity(identity).then((resolved) => {
      const key = this.keyFor(resolved);
      if (!options?.reload) {
        const pending = this.openOperations.get(key);
        if (pending) return pending;
      }
      const operation = this.performOpen(resolved, options);
      if (options?.reload) return operation;
      this.openOperations.set(key, operation);
      void operation.finally(() => {
        if (this.openOperations.get(key) === operation) this.openOperations.delete(key);
      }).catch(() => undefined);
      return operation;
    });
  }

  private async performOpen(identity: DocumentIdentity, options?: { reload?: boolean }): Promise<DocumentRecord> {
    this.assertActive();
    const key = this.keyFor(identity);
    const generation = this.getGeneration();
    const existing = this.records.get(key);
    if (
      !options?.reload
      && existing
      && existing.connectionGeneration === generation
      && existing.status !== 'unloaded'
      && existing.status !== 'loading'
    ) {
      this.ensureWatch(identity.workspaceId);
      if (!existing.dirty) await this.restoreJournalIfNeeded(existing);
      return this.records.get(key) ?? existing;
    }
    const capturedEdit = existing?.localEditRevision ?? 0;
    const loading: DocumentRecord = {
      ...(existing ?? emptyRecord(identity, generation, this.createDocumentInstanceId())),
      identity,
      connectionGeneration: generation,
      status: 'loading',
    };
    this.commit(loading);
    this.ensureWatch(identity.workspaceId);
    try {
      const result = await this.documents.read(identity);
      if (this.disposed || generation !== this.getGeneration()) return loading;
      const current = this.records.get(key) ?? loading;
      if (current.localEditRevision !== capturedEdit) {
        const next = applyRead({ ...current, dirty: true }, result);
        this.commit({
          ...next,
          buffer: current.buffer,
          dirty: current.buffer !== next.baseContent,
          localEditRevision: current.localEditRevision,
        });
        return this.records.get(key) ?? current;
      }
      const next = applyRead(current, result);
      this.commit(next);
      await this.restoreJournalIfNeeded(this.records.get(key) ?? next);
      return this.records.get(key) ?? next;
    } catch (error) {
      if (this.disposed || generation !== this.getGeneration()) return loading;
      const current = this.records.get(key) ?? loading;
      if (current.dirty) {
        this.commit({
          ...current,
          status: current.status === 'loading' ? 'ready' : current.status,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return this.records.get(key) ?? current;
      }
      this.commit({
        ...current,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return this.records.get(key) ?? current;
    }
  }

  applyTransaction(
    identity: DocumentIdentity,
    buffer: string,
    options: { origin: string; changes?: DocumentChange[] } ,
  ): DocumentRecord {
    this.assertActive();
    this.assertDirtyBarrierAllowsEdit(identity);
    const current = this.records.get(this.keyFor(identity))
      ?? emptyRecord(identity, this.getGeneration(), this.createDocumentInstanceId());
    if (current.status === 'binary' || current.status === 'unsupported-encoding') return current;
    const dirty = buffer !== current.baseContent;
    const next: DocumentRecord = {
      ...current,
      buffer,
      dirty,
      localEditRevision: current.localEditRevision + 1,
      status: current.status === 'deleted' || current.status === 'conflict' || current.status === 'missing'
        ? current.status
        : current.status === 'loading' || current.status === 'unloaded'
          ? current.status
          : 'ready',
      lastOrigin: options.origin,
      lastChanges: options.changes ?? null,
      errorMessage: current.status === 'error' ? current.errorMessage : null,
    };
    this.commit(next);
    this.scheduleJournal(next);
    return next;
  }

  applyEdits(
    identity: DocumentIdentity,
    input: {
      expectedLocalEditRevision: number;
      edits: DocumentChange[];
      origin: string;
    },
  ): DocumentEditResult {
    this.assertActive();
    const current = this.records.get(this.keyFor(identity))
      ?? emptyRecord(identity, this.getGeneration(), this.createDocumentInstanceId());
    if (current.status === 'binary' || current.status === 'unsupported-encoding') {
      return { status: 'unsupported', record: current };
    }
    if (input.expectedLocalEditRevision !== current.localEditRevision) {
      return {
        status: 'stale',
        record: current,
        expectedLocalEditRevision: input.expectedLocalEditRevision,
        actualLocalEditRevision: current.localEditRevision,
      };
    }

    const indexed = input.edits.map((edit, index) => ({ ...edit, index }));
    if (indexed.some((edit) => (
      !Number.isSafeInteger(edit.from)
      || !Number.isSafeInteger(edit.to)
      || edit.from < 0
      || edit.to < edit.from
      || edit.to > current.buffer.length
    ))) {
      return { status: 'invalid', reason: 'invalid-range', record: current };
    }
    const ascending = [...indexed].sort((left, right) => (
      left.from - right.from || left.to - right.to || left.index - right.index
    ));
    for (let index = 1; index < ascending.length; index += 1) {
      const previous = ascending[index - 1];
      const candidate = ascending[index];
      if (previous.to > candidate.from) {
        return { status: 'invalid', reason: 'overlapping-ranges', record: current };
      }
    }
    if (indexed.length === 0) return { status: 'applied', record: current };

    const changes = [...indexed]
      .sort((left, right) => right.from - left.from || right.to - left.to || right.index - left.index)
      .map(({ from, to, insert }) => ({ from, to, insert }));
    let buffer = current.buffer;
    for (const edit of changes) {
      buffer = `${buffer.slice(0, edit.from)}${edit.insert}${buffer.slice(edit.to)}`;
    }
    const next = this.applyTransaction(identity, buffer, { origin: input.origin, changes });
    return { status: 'applied', record: next };
  }

  async prepareWorkspaceEdit(input: DocumentWorkspaceEditInput): Promise<DocumentWorkspaceEditPrepareResult> {
    this.assertActive();
    const generation = this.getGeneration();
    const failures: DocumentWorkspaceEditFailure[] = [];
    if (input.resourceOperations && input.resourceOperations.length > 0) {
      failures.push({
        reason: 'resource-operation-unsupported',
        message: 'Workspace resource create, rename, and delete operations require a Host batch mutation contract',
      });
    }
    const grouped = new Map<string, {
      identity: DocumentIdentity;
      edits: DocumentWorkspaceTextEdit[];
      versions: Set<number>;
    }>();
    for (const change of input.textEdits) {
      if (change.identity.workspaceId !== input.workspaceId) {
        failures.push({
          identity: change.identity,
          reason: 'workspace-mismatch',
          message: 'Workspace edit targets another workspace',
        });
        continue;
      }
      let resolved: DocumentIdentity;
      try {
        resolved = await this.resolveIdentity(change.identity);
      } catch (error) {
        failures.push({ identity: change.identity, reason: 'not-ready', message: error instanceof Error ? error.message : 'Document identity is unavailable' });
        continue;
      }
      const key = this.keyFor(resolved);
      const item = grouped.get(key) ?? { identity: resolved, edits: [], versions: new Set<number>() };
      item.edits.push(...change.edits);
      if (change.version !== null) item.versions.add(change.version);
      grouped.set(key, item);
    }
    for (const item of grouped.values()) {
      if (item.versions.size > 1) {
        failures.push({
          identity: item.identity,
          reason: 'stale-version',
          message: 'Workspace edit contains conflicting document versions',
        });
      }
    }
    if (failures.length > 0) return { status: 'rejected', failures };

    const loaded = await Promise.all([...grouped.values()].map(async (item) => {
      const existing = this.records.get(this.keyFor(item.identity));
      if (existing) return { item, record: existing, wasOpen: true };
      try {
        const result = await this.documents.read(item.identity);
        const record = applyRead(
          emptyRecord(item.identity, generation, this.createDocumentInstanceId()),
          result,
        );
        return { item, record, wasOpen: false };
      } catch (error) {
        failures.push({
          identity: item.identity,
          reason: 'not-ready',
          message: error instanceof Error ? error.message : 'Document could not be loaded',
        });
        return null;
      }
    }));
    if (this.disposed || generation !== this.getGeneration()) {
      return {
        status: 'rejected',
        failures: [{ reason: 'stale-plan', message: 'Application Host changed while preparing the workspace edit' }],
      };
    }
    const documents: PreparedWorkspaceDocument[] = [];
    for (const loadedItem of loaded) {
      if (!loadedItem) continue;
      const { item, record, wasOpen } = loadedItem;
      if (record.saving) {
        failures.push({ identity: item.identity, reason: 'saving', message: 'Document is currently being saved' });
        continue;
      }
      if (record.status === 'binary') {
        failures.push({ identity: item.identity, reason: 'binary', message: 'Binary documents cannot receive text edits' });
        continue;
      }
      if (record.status === 'unsupported-encoding') {
        failures.push({ identity: item.identity, reason: 'unsupported-encoding', message: 'Document encoding is not editable' });
        continue;
      }
      if (record.status === 'conflict') {
        failures.push({ identity: item.identity, reason: 'conflict', message: 'Document already has an unresolved disk conflict' });
        continue;
      }
      if (record.status === 'missing' || record.status === 'deleted') {
        failures.push({ identity: item.identity, reason: 'missing', message: 'Document does not exist' });
        continue;
      }
      if (record.status !== 'ready') {
        failures.push({ identity: item.identity, reason: 'not-ready', message: 'Document is not ready for editing' });
        continue;
      }
      const expectedVersion = item.versions.values().next().value as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== record.localEditRevision) {
        failures.push({
          identity: item.identity,
          reason: 'stale-version',
          message: `Document version changed from ${expectedVersion} to ${record.localEditRevision}`,
        });
        continue;
      }
      const prepared = prepareTextChanges(record.buffer, item.edits);
      if (prepared.status !== 'ready') {
        failures.push({
          identity: item.identity,
          reason: prepared.status,
          message: prepared.status === 'invalid-range'
            ? 'Workspace edit contains a range outside the current document'
            : 'Workspace edit contains overlapping ranges',
        });
        continue;
      }
      if (prepared.buffer === record.buffer) continue;
      documents.push({
        before: structuredClone(record),
        afterBuffer: prepared.buffer,
        changes: prepared.changes,
        editCount: item.edits.length,
        wasOpen,
      });
    }
    if (failures.length > 0) return { status: 'rejected', failures };
    const groupId = input.groupId?.trim() || crypto.randomUUID();
    if (input.groupId && this.preparedWorkspaceEdits.has(groupId)) {
      this.preparedWorkspaceEdits.delete(groupId);
    }
    const annotationIds = new Set(input.textEdits.flatMap((change) => (
      change.edits.map((edit) => edit.annotationId).filter((value): value is string => Boolean(value))
    )));
    const requiresConfirmation = [...annotationIds].some((annotationId) => (
      input.changeAnnotations?.[annotationId]?.needsConfirmation === true
    ));
    const preview: DocumentWorkspaceEditPreview = {
      status: 'ready',
      groupId,
      workspaceId: input.workspaceId,
      origin: input.origin,
      files: documents.map((document) => ({
        identity: document.before.identity,
        beforeContent: document.before.buffer,
        afterContent: document.afterBuffer,
        editCount: document.editCount,
      })),
      requiresConfirmation,
    };
    this.preparedWorkspaceEdits.set(groupId, { generation, preview, documents });
    return preview;
  }

  async applyWorkspaceEdit(groupId: string): Promise<DocumentWorkspaceEditApplyResult> {
    this.assertActive();
    const prepared = this.preparedWorkspaceEdits.get(groupId);
    if (!prepared) {
      return {
        status: 'rejected',
        failures: [{ reason: 'stale-plan', message: 'Workspace edit preview is no longer available' }],
      };
    }
    const failures: DocumentWorkspaceEditFailure[] = [];
    for (const document of prepared.documents) {
      if (this.isDirtyBarrierHeld(document.before.identity)) {
        failures.push({
          identity: document.before.identity,
          reason: 'stale-plan',
          message: 'Document is temporarily fenced while workspace recovery is applied',
        });
      }
    }
    if (prepared.generation !== this.getGeneration()) {
      failures.push({ reason: 'stale-plan', message: 'Application Host changed after the workspace edit was previewed' });
    }
    const diskSnapshots = new Map<string, DocumentRecord>();
    await Promise.all(prepared.documents.filter((document) => !document.wasOpen).map(async (document) => {
      try {
        const read = await this.documents.read(document.before.identity);
        diskSnapshots.set(
          this.keyFor(document.before.identity),
          applyRead(
            emptyRecord(document.before.identity, prepared.generation, document.before.documentInstanceId),
            read,
          ),
        );
      } catch (error) {
        failures.push({
          identity: document.before.identity,
          reason: 'not-ready',
          message: error instanceof Error ? error.message : 'Document could not be revalidated',
        });
      }
    }));
    for (const document of prepared.documents) {
      const current = this.records.get(this.keyFor(document.before.identity))
        ?? diskSnapshots.get(this.keyFor(document.before.identity));
      if (!current
        || current.documentInstanceId !== document.before.documentInstanceId
        || current.connectionGeneration !== document.before.connectionGeneration
        || current.workspaceEpoch !== document.before.workspaceEpoch
        || current.baseRevision !== document.before.baseRevision
        || current.encoding !== document.before.encoding
        || current.bom !== document.before.bom
        || current.lineEnding !== document.before.lineEnding
        || current.localEditRevision !== document.before.localEditRevision
        || current.buffer !== document.before.buffer
        || current.status !== document.before.status
        || current.saving) {
        failures.push({
          identity: document.before.identity,
          reason: 'stale-plan',
          message: 'Document changed after the workspace edit was previewed',
        });
        continue;
      }
      if (!document.wasOpen && current.baseRevision !== document.before.baseRevision) {
        failures.push({
          identity: document.before.identity,
          reason: 'stale-plan',
          message: 'Document changed on disk after the workspace edit was previewed',
        });
      }
    }
    if (failures.length > 0) {
      this.preparedWorkspaceEdits.delete(groupId);
      return { status: 'rejected', failures };
    }

    const records = prepared.documents.map((document) => {
      const current = this.records.get(this.keyFor(document.before.identity)) ?? document.before;
      return {
        ...current,
        buffer: document.afterBuffer,
        dirty: document.afterBuffer !== current.baseContent,
        localEditRevision: current.localEditRevision + 1,
        status: 'ready' as const,
        lastOrigin: prepared.preview.origin,
        lastChanges: document.changes,
        errorMessage: null,
      };
    });
    this.preparedWorkspaceEdits.delete(groupId);
    this.invalidateWorkspaceEditUndoGroups(records.map((record) => record.identity));
    this.workspaceEditUndoGroups.set(groupId, {
      groupId,
      documents: records.map((record, index) => ({
        identity: record.identity,
        beforeBuffer: prepared.documents[index].before.buffer,
        appliedBuffer: record.buffer,
        appliedRevision: record.localEditRevision,
      })),
    });
    this.commitAtomic(records, prepared.preview.workspaceId);
    return { status: 'applied', groupId, records };
  }

  discardWorkspaceEdit(groupId: string): void {
    this.preparedWorkspaceEdits.delete(groupId);
  }

  undoWorkspaceEdit(groupId: string): DocumentWorkspaceEditUndoResult {
    this.assertActive();
    const group = this.workspaceEditUndoGroups.get(groupId);
    if (!group) return { status: 'unavailable', groupId };
    const failures: DocumentWorkspaceEditFailure[] = [];
    for (const document of group.documents) {
      if (this.isDirtyBarrierHeld(document.identity)) {
        failures.push({
          identity: document.identity,
          reason: 'stale-plan',
          message: 'Document is temporarily fenced while workspace recovery is applied',
        });
        continue;
      }
      const current = this.records.get(this.keyFor(document.identity));
      if (!current
        || current.localEditRevision !== document.appliedRevision
        || current.buffer !== document.appliedBuffer
        || current.saving
        || current.status === 'conflict') {
        failures.push({
          identity: document.identity,
          reason: 'stale-plan',
          message: 'Document changed after the workspace edit was applied',
        });
      }
    }
    if (failures.length > 0) {
      this.workspaceEditUndoGroups.delete(groupId);
      return { status: 'rejected', groupId, failures };
    }
    this.workspaceEditUndoGroups.delete(groupId);
    const records = group.documents.map((document) => {
      const current = this.records.get(this.keyFor(document.identity))!;
      const change = replacementBetween(current.buffer, document.beforeBuffer);
      return {
        ...current,
        buffer: document.beforeBuffer,
        dirty: document.beforeBuffer !== current.baseContent,
        localEditRevision: current.localEditRevision + 1,
        status: 'ready' as const,
        lastOrigin: `workspace-edit-undo:${groupId}`,
        lastChanges: change ? [change] : [],
        errorMessage: null,
      };
    });
    this.commitAtomic(records, records[0]?.identity.workspaceId ?? '');
    return { status: 'undone', groupId, records };
  }

  async save(
    identity: DocumentIdentity,
    options: { overwriteConflict?: boolean; recreateDeleted?: boolean } = {},
  ): Promise<DocumentRecord> {
    this.assertActive();
    this.assertDirtyBarrierAllowsEdit(identity);
    const generation = this.getGeneration();
    const current = this.records.get(this.keyFor(identity));
    if (!current) throw new DocumentsError('Document is not open', { reason: 'failed' });
    if (!current.dirty) return current;
    if (current.saving) return current;
    if (current.status === 'binary' || current.status === 'unsupported-encoding') return current;
    if (current.status === 'conflict' && !options.overwriteConflict) return current;
    if (current.status === 'deleted' && !options.recreateDeleted) return current;
    const operationId = crypto.randomUUID();
    const capturedEdit = current.localEditRevision;
    const content = serializeEditorContent(current.buffer, current.lineEnding);
    this.commit({
      ...current,
      saving: true,
      saveOperationId: operationId,
      saveCapturedEditRevision: capturedEdit,
    });
    try {
      const result = await this.documents.write({
        token: {
          workspaceId: current.identity.workspaceId,
          epoch: requireWorkspaceEpoch(current.workspaceEpoch),
          owner: {
            kind: 'document-surface',
            id: this.recoverySessionId,
            generation: current.connectionGeneration,
          },
        },
        resource: current.identity,
        content,
        encoding: current.encoding,
        bom: current.bom,
        expectedRevision: options.recreateDeleted || current.baseRevision === null ? null : current.baseRevision,
        operationId,
      });
      if (this.disposed || generation !== this.getGeneration()) return current;
      const latest = this.records.get(this.keyFor(identity)) ?? current;
      if (result.status === 'stale-epoch') {
        this.commit({
          ...latest,
          saving: false,
          saveOperationId: null,
          saveCapturedEditRevision: null,
          errorMessage: `Workspace epoch changed to ${result.currentEpoch}; reload before saving`,
        });
        return this.records.get(this.keyFor(identity)) ?? latest;
      }
      if (result.status === 'conflict') {
        const disk = await this.documents.read(current.identity);
        if (this.disposed || generation !== this.getGeneration()) return latest;
        const withDisk = applyRead(latest, disk);
        this.commit({
          ...withDisk,
          saving: false,
          saveOperationId: null,
          saveCapturedEditRevision: null,
          buffer: latest.buffer,
          dirty: true,
          localEditRevision: latest.localEditRevision,
          status: 'conflict',
          conflict: {
            diskRevision: disk.status === 'missing' ? 'missing' : disk.revision,
            ancestorContent: latest.conflict?.ancestorContent ?? latest.baseContent,
            ancestorRevision: latest.conflict?.ancestorRevision ?? latest.baseRevision,
            diskContent: disk.status === 'ready' ? normalizeEditorLineEndings(disk.content) : '',
          },
        });
        return this.records.get(this.keyFor(identity)) ?? latest;
      }
      const stillDirty = latest.localEditRevision !== capturedEdit;
      const saved: DocumentRecord = {
        ...latest,
        saving: false,
        saveOperationId: null,
        saveCapturedEditRevision: null,
        baseContent: stillDirty ? latest.baseContent === latest.buffer ? latest.buffer : normalizeEditorLineEndings(content) : latest.buffer,
        buffer: latest.buffer,
        baseRevision: result.revision,
        dirty: stillDirty,
        byteLength: result.byteLength,
        status: 'ready',
        conflict: null,
        errorMessage: null,
      };
      if (stillDirty) {
        saved.baseContent = normalizeEditorLineEndings(content);
        saved.dirty = saved.buffer !== saved.baseContent;
      }
      this.commit(saved);
      if (saved.dirty) this.scheduleJournal(saved);
      else await this.clearJournal(saved);
      return saved;
    } catch (error) {
      if (this.disposed || generation !== this.getGeneration()) return current;
      const latest = this.records.get(this.keyFor(identity)) ?? current;
      this.commit({
        ...latest,
        saving: false,
        saveOperationId: null,
        saveCapturedEditRevision: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async create(identity: DocumentIdentity, content = ''): Promise<DocumentRecord> {
    this.assertActive();
    identity = await this.resolveIdentity(identity);
    this.assertDirtyBarrierAllowsEdit(identity);
    const generation = this.getGeneration();
    const current = this.records.get(this.keyFor(identity));
    const snapshot = current ?? applyRead(
      emptyRecord(identity, generation, this.createDocumentInstanceId()),
      await this.documents.read(identity),
    );
    if (snapshot.status !== 'missing') return this.open(identity);
    const result = await this.documents.write({
      token: {
        workspaceId: identity.workspaceId,
        epoch: requireWorkspaceEpoch(snapshot.workspaceEpoch),
        owner: { kind: 'document-surface', id: this.recoverySessionId, generation },
      },
      resource: identity,
      content,
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: crypto.randomUUID(),
    });
    if (result.status === 'conflict' || result.status === 'stale-epoch') {
      return this.open(identity);
    }
    if (this.disposed || generation !== this.getGeneration()) {
      return emptyRecord(identity, generation, this.createDocumentInstanceId());
    }
    return this.open(identity);
  }

  async reload(identity: DocumentIdentity): Promise<DocumentRecord> {
    return this.open(identity, { reload: true });
  }

  discard(identity: DocumentIdentity): DocumentRecord | undefined {
    this.assertDirtyBarrierAllowsEdit(identity);
    const current = this.records.get(this.keyFor(identity));
    if (!current) return undefined;
    const next: DocumentRecord = {
      ...current,
      buffer: current.baseContent,
      dirty: false,
      status: current.status === 'conflict' ? 'ready' : current.status === 'deleted' ? 'deleted' : current.status,
      conflict: current.status === 'conflict' ? null : current.conflict,
      lastChanges: null,
      lastOrigin: 'discard',
    };
    this.commit(next);
    void this.clearJournal(next);
    return next;
  }

  async applyMerged(identity: DocumentIdentity, merged: string): Promise<DocumentRecord> {
    this.applyTransaction(identity, merged, { origin: 'merge' });
    return this.save(identity, { overwriteConflict: true });
  }

  private async waitForDirtyBarrierSaves(barrier: DirtyBarrierHold): Promise<boolean> {
    const affected = () => [...this.records.values()].filter((record) => (
      this.aliasesFor(record.identity).some((alias) => alias.workspaceId === barrier.workspaceId
        && barrier.paths.has(this.barrierPath(alias.resourceId, barrier.caseSensitive)))
    ));
    if (!affected().some((record) => record.saving)) return true;
    return new Promise((resolve) => {
      let settled = false;
      const unsubscribers: Array<() => void> = [];
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        for (const unsubscribe of unsubscribers) unsubscribe();
        resolve(ready);
      };
      const check = () => {
        if (!barrier.active) finish(false);
        else if (!affected().some((record) => record.saving)) finish(true);
      };
      for (const record of affected()) unsubscribers.push(this.subscribe(record.identity, check));
      void barrier.released.then(() => finish(false));
      check();
    });
  }

  private async handleDirtyStateBarrier(event: VarinDirtyStateBarrierEvent): Promise<void> {
    const existing = this.dirtyBarriers.get(event.barrierId);
    if (event.action === 'release') {
      if (existing) {
        existing.active = false;
        existing.release();
        this.dirtyBarriers.delete(event.barrierId);
      }
      return;
    }
    if (existing?.active) return;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const barrier: DirtyBarrierHold = {
      active: true,
      barrierId: event.barrierId,
      caseSensitive: event.caseSensitive,
      paths: new Set(event.paths.map((entry) => this.barrierPath(entry, event.caseSensitive))),
      release,
      released,
      workspaceId: event.workspaceId,
    };
    this.dirtyBarriers.set(event.barrierId, barrier);
    try {
      if (!await this.waitForDirtyBarrierSaves(barrier) || !barrier.active) return;
      await this.publishDirtyWorkspace(event.workspaceId);
      if (!barrier.active) return;
      const result = await this.documents.ackDirtyStateBarrier?.({
        barrierId: event.barrierId,
        generation: this.getGeneration(),
        ownerId: this.dirtyOwnerId,
        workspaceId: event.workspaceId,
      });
      if (!result?.acknowledged) {
        barrier.active = false;
        barrier.release();
        this.dirtyBarriers.delete(event.barrierId);
      }
    } catch (error) {
      barrier.active = false;
      barrier.release();
      this.dirtyBarriers.delete(event.barrierId);
      this.reportJournalFailure(error);
    }
  }

  handleWatchEvent(event: VarinWorkspaceFileEvent, resetWorkspaceId?: string): void {
    if (event.kind === 'reset') {
      const records = [...this.records.values()].filter((record) => (
        !resetWorkspaceId || this.aliasesFor(record.identity).some((alias) => alias.workspaceId === resetWorkspaceId)
      ));
      for (const record of records) {
        if (record.status === 'loading') continue;
        void this.open(record.identity, { reload: true });
      }
      return;
    }
    const identity = event.kind === 'moved' ? event.from : event.resource;
    const current = this.records.get(this.keyFor(identity));
    if (!current) return;
    if (event.kind === 'deleted') {
      const deleted = applyRead(current, {
        status: 'missing',
        epoch: requireWorkspaceEpoch(current.workspaceEpoch),
        resource: current.identity,
      });
      const externalSource = peekAgentFileChangeHint(current.identity) ? 'agent' : 'disk';
      this.commit({ ...deleted, externalSource });
      return;
    }
    if (event.kind === 'moved') {
      const previousKey = `${identity.workspaceId}\0${identity.resourceId}`;
      this.removeRecord(current);
      const moved: DocumentRecord = {
        ...current,
        identity: event.resource,
      };
      this.commit(moved);
      const prevListeners = this.listeners.get(previousKey);
      if (prevListeners) {
        this.listeners.delete(previousKey);
        this.listeners.set(`${event.resource.workspaceId}\0${event.resource.resourceId}`, prevListeners);
        for (const listener of prevListeners) listener(moved);
      }
      const movedKey = `${event.resource.workspaceId}\0${event.resource.resourceId}`;
      void this.resolveIdentity(event.resource).then((resolved) => {
        if (this.records.get(movedKey) !== moved) return;
        this.records.delete(movedKey);
        this.commit({ ...moved, identity: resolved });
      }).catch((error) => this.reportJournalFailure(error));
      return;
    }
    if (event.kind === 'changed' || event.kind === 'created') {
      if (current.saving || current.status === 'loading') return;
      if (event.revision && event.revision === current.baseRevision) return;
      void this.open(current.identity, { reload: true }).then((record) => {
        if (this.disposed) return;
        const latest = this.records.get(this.keyFor(record.identity));
        if (!latest) return;
        const externalSource = peekAgentFileChangeHint(record.identity) ? 'agent' : 'disk';
        if (latest.externalSource === externalSource) return;
        this.commit({ ...latest, externalSource });
      });
    }
  }

  async flushRecoveryJournals(): Promise<void> {
    if (this.disposed) return;
    const dirtyRecords = [...this.records.values()].filter((record) => record.dirty);
    for (const record of dirtyRecords) {
      const key = this.keyFor(record.identity);
      const timer = this.journalTimers.get(key);
      if (timer) clearTimeout(timer);
      this.journalTimers.delete(key);
    }
    const results = await Promise.allSettled(dirtyRecords.map((record) => (
      this.enqueueJournal(record.identity, () => this.writeJournalRecord(record, true))
    )));
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        this.reportJournalFailure(result.reason);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to persist document recovery journals');
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const pendingPublications: Promise<unknown>[] = [];
    const dirtyRecords = [...this.records.values()].filter((record) => record.dirty);
    const dirtyWorkspaces = [...this.dirtyIdsByWorkspace.keys()];
    this.disposed = true;
    for (const timer of this.journalTimers.values()) clearTimeout(timer);
    this.journalTimers.clear();
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.listeners.clear();
    this.dirtyListenersByWorkspace.clear();
    this.workspaceListeners.clear();
    for (const record of dirtyRecords) {
      void this.enqueueJournal(record.identity, () => this.writeJournalRecord(record, false))
        .catch((error) => this.reportJournalFailure(error));
    }
    this.records.clear();
    this.coordinationByAlias.clear();
    this.aliasesByCoordination.clear();
    this.availableAliases.clear();
    this.openOperations.clear();
    this.dirtyIdsByWorkspace.clear();
    this.workspaceVersions.clear();
    this.preparedWorkspaceEdits.clear();
    this.workspaceEditUndoGroups.clear();
    for (const barrier of this.dirtyBarriers.values()) {
      barrier.active = false;
      barrier.release();
    }
    this.dirtyBarriers.clear();
    for (const workspaceId of dirtyWorkspaces) {
      const previous = this.dirtyPublicationTails.get(workspaceId) ?? Promise.resolve();
      const generation = this.getGeneration();
      pendingPublications.push(previous.catch(() => undefined).then(() => this.documents.clearDirtyBuffers({
        generation,
        ownerId: this.dirtyOwnerId,
        workspaceId,
      })).catch(() => undefined));
    }
    this.dirtyPublicationTails.clear();
    // Callers sharing the Host process must observe final journal/dirty-owner
    // delivery before disposing the authority it writes to.
    this.disposePromise = Promise.allSettled([...this.journalOperations.values(), ...pendingPublications]).then(() => undefined);
    return this.disposePromise;
  }

  private commit(record: DocumentRecord): void {
    const key = this.keyFor(record.identity);
    const previous = this.records.get(key);
    if (previous && (
      previous.buffer !== record.buffer
      || previous.localEditRevision !== record.localEditRevision
      || previous.status !== record.status
      || previous.conflict !== record.conflict
    )) {
      this.invalidateWorkspaceEditUndoGroups([record.identity]);
    }
    this.records.set(key, record);
    if (previous?.dirty !== record.dirty) {
      this.updateDirtyIndex(record.identity, record.dirty);
    } else if (!previous && record.dirty) {
      this.updateDirtyIndex(record.identity, true);
    } else if (record.dirty && previous?.localEditRevision !== record.localEditRevision) {
      for (const workspaceId of new Set(this.availableAliasesFor(record.identity).map((alias) => alias.workspaceId))) {
        void this.publishDirtyWorkspace(workspaceId);
      }
    }
    for (const alias of this.aliasesFor(record.identity)) {
      const set = this.listeners.get(`${alias.workspaceId}\0${alias.resourceId}`);
      if (set) for (const listener of set) {
        try { listener(record); } catch (error) { this.reportJournalFailure(error); }
      }
    }
    if (
      !previous
      || previous.status !== record.status
      || previous.dirty !== record.dirty
      || previous.saving !== record.saving
      || previous.baseRevision !== record.baseRevision
      || previous.errorMessage !== record.errorMessage
      || previous.externalSource !== record.externalSource
      || previous.conflict !== record.conflict
    ) {
      for (const workspaceId of new Set(this.aliasesFor(record.identity).map((alias) => alias.workspaceId))) {
        this.notifyWorkspace(workspaceId);
      }
    }
  }

  private removeRecord(record: DocumentRecord): void {
    this.invalidateWorkspaceEditUndoGroups([record.identity]);
    this.records.delete(this.keyFor(record.identity));
    if (record.dirty) this.updateDirtyIndex(record.identity, false);
    for (const workspaceId of new Set(this.aliasesFor(record.identity).map((alias) => alias.workspaceId))) {
      this.notifyWorkspace(workspaceId);
    }
  }

  private updateDirtyIndex(identity: DocumentIdentity, dirty: boolean): void {
    for (const alias of this.aliasesFor(identity)) this.updateDirtyIndexAlias(alias, dirty);
  }

  private updateDirtyIndexAlias(identity: DocumentIdentity, dirty: boolean): void {
    const available = this.availableAliases.has(`${identity.workspaceId}\0${identity.resourceId}`);
    if (dirty && available) this.ensureWatch(identity.workspaceId);
    const previous = this.dirtyIdsByWorkspace.get(identity.workspaceId) ?? EMPTY_RESOURCE_IDS;
    const next = new Set(previous);
    if (dirty) next.add(identity.resourceId);
    else next.delete(identity.resourceId);
    if (previous.size === next.size && [...previous].every((resourceId) => next.has(resourceId))) return;
    this.dirtyIdsByWorkspace.set(identity.workspaceId, next);
    if (available) void this.publishDirtyWorkspace(identity.workspaceId);
    const listeners = this.dirtyListenersByWorkspace.get(identity.workspaceId);
    if (listeners) {
      for (const listener of listeners) listener();
    }
  }

  private async publishDirtyWorkspace(workspaceId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const resources = await Promise.all([...this.records.values()]
      .filter((record) => record.dirty)
      .flatMap((record) => this.availableAliasesFor(record.identity)
        .filter((alias) => alias.workspaceId === workspaceId)
        .map((alias) => ({ record, alias })))
      .map(async ({ record, alias }) => ({
        baseRevision: record.baseRevision,
        bufferHash: await bufferHash(record.buffer),
        documentInstanceId: record.documentInstanceId,
        encoding: record.encoding,
        bom: record.bom,
        lineEnding: record.lineEnding,
        localEditRevision: record.localEditRevision,
        resource: { workspaceId: alias.workspaceId, resourceId: alias.resourceId },
      })));
    const generation = this.getGeneration();
    return this.enqueueDirtyPublication(workspaceId, generation, resources);
  }

  private enqueueDirtyPublication(
    workspaceId: string,
    generation: number,
    resources: Array<{
      baseRevision: string | null;
      bufferHash?: string;
      documentInstanceId?: string;
      encoding?: string;
      bom?: boolean;
      lineEnding?: 'lf' | 'crlf' | 'cr';
      localEditRevision: number;
      resource: DocumentIdentity;
    }>,
  ): Promise<void> {
    const previous = this.dirtyPublicationTails.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.documents.publishDirtyBuffers({ generation, ownerId: this.dirtyOwnerId, resources, workspaceId });
    });
    this.dirtyPublicationTails.set(workspaceId, current);
    void current.catch((error) => this.reportJournalFailure(error)).finally(() => {
      if (this.dirtyPublicationTails.get(workspaceId) === current) {
        this.dirtyPublicationTails.delete(workspaceId);
      }
    });
    return current;
  }

  private commitAtomic(records: DocumentRecord[], workspaceId: string): void {
    if (records.length === 0) return;
    const affected = new Map<string, Array<{ record: DocumentRecord; alias: DocumentIdentity }>>();
    for (const record of records) {
      this.records.set(this.keyFor(record.identity), record);
      for (const alias of this.aliasesFor(record.identity)) {
        const rows = affected.get(alias.workspaceId) ?? [];
        rows.push({ record, alias });
        affected.set(alias.workspaceId, rows);
      }
    }
    if (!affected.has(workspaceId)) affected.set(workspaceId, []);
    for (const [id, rows] of affected) {
      const available = rows.some(({ alias }) => this.availableAliases.has(`${alias.workspaceId}\0${alias.resourceId}`));
      if (available) this.ensureWatch(id);
      const previousDirty = this.dirtyIdsByWorkspace.get(id) ?? EMPTY_RESOURCE_IDS;
      const nextDirty = new Set(previousDirty);
      for (const { record, alias } of rows) {
        if (record.dirty) nextDirty.add(alias.resourceId);
        else nextDirty.delete(alias.resourceId);
      }
      this.dirtyIdsByWorkspace.set(id, nextDirty);
      if (available && (!sameResourceSet(previousDirty, nextDirty) || rows.some(({ record }) => record.dirty))) {
        void this.publishDirtyWorkspace(id);
      }
      this.workspaceVersions.set(id, (this.workspaceVersions.get(id) ?? 0) + 1);
      if (!sameResourceSet(previousDirty, nextDirty)) {
        const listeners = this.dirtyListenersByWorkspace.get(id);
        if (listeners) for (const listener of listeners) {
          try { listener(); } catch (error) { this.reportJournalFailure(error); }
        }
      }
      const workspaceListeners = this.workspaceListeners.get(id);
      if (workspaceListeners) for (const listener of workspaceListeners) {
        try { listener(); } catch (error) { this.reportJournalFailure(error); }
      }
    }
    for (const record of records) {
      for (const alias of this.aliasesFor(record.identity)) {
        const listeners = this.listeners.get(`${alias.workspaceId}\0${alias.resourceId}`);
        if (listeners) for (const listener of listeners) {
          try { listener(record); } catch (error) { this.reportJournalFailure(error); }
        }
      }
    }
    for (const record of records) this.scheduleJournal(record);
  }

  private invalidateWorkspaceEditUndoGroups(identities: readonly DocumentIdentity[]): void {
    const keys = new Set(identities.map((identity) => this.keyFor(identity)));
    for (const [groupId, group] of this.workspaceEditUndoGroups) {
      if (group.documents.some((document) => keys.has(this.keyFor(document.identity)))) {
        this.workspaceEditUndoGroups.delete(groupId);
      }
    }
  }

  private notifyWorkspace(workspaceId: string): void {
    this.workspaceVersions.set(workspaceId, (this.workspaceVersions.get(workspaceId) ?? 0) + 1);
    const listeners = this.workspaceListeners.get(workspaceId);
    if (listeners) {
      for (const listener of listeners) listener();
    }
  }

  private ensureWatch(workspaceId: string): void {
    if (this.watches.has(workspaceId)) return;
    const subscription = this.documents.watch(workspaceId, (event) => {
      if (event.kind === 'dirty-state-barrier') {
        void this.handleDirtyStateBarrier(event);
      } else if (event.kind === 'surface-operation') {
        void this.handleSurfaceOperation(event);
      } else {
        this.handleWatchEvent(event, workspaceId);
      }
    }, {
      dirtyOwner: { generation: this.getGeneration(), ownerId: this.dirtyOwnerId },
    });
    this.watches.set(workspaceId, subscription);
  }

  private async handleSurfaceOperation(event: VarinDocumentSurfaceOperationEvent): Promise<void> {
    if (!this.documents.readSurfaceOperation || !this.documents.completeSurfaceOperation) return;
    const owner = this.surfaceOwner();
    let payload: VarinDocumentSurfaceOperationPayload;
    try {
      payload = await this.documents.readSurfaceOperation({
        ...owner,
        requestId: event.requestId,
        workspaceId: event.workspaceId,
      });
    } catch (error) {
      this.reportJournalFailure(error);
      return;
    }
    const failed = (message: string): VarinDocumentSurfaceOperationResourceResult[] => payload.targets.map((target) => ({
      resource: target.resource,
      status: 'failed',
      message,
    }));
    let resources: VarinDocumentSurfaceOperationResourceResult[];
    try {
      resources = await this.executeSurfaceOperation(payload);
    } catch (error) {
      resources = failed(error instanceof Error ? error.message : String(error));
    }
    try {
      await this.documents.completeSurfaceOperation({
        ...owner,
        operationId: payload.operationId,
        requestId: payload.requestId,
        resources,
        workspaceId: payload.workspaceId,
      });
    } catch (error) {
      this.reportJournalFailure(error);
    }
  }

  private async executeSurfaceOperation(
    payload: VarinDocumentSurfaceOperationPayload,
  ): Promise<VarinDocumentSurfaceOperationResourceResult[]> {
    const existingUndoGroup = payload.action === 'apply'
      ? this.workspaceEditUndoGroups.get(payload.operationId)
      : undefined;
    const existingByPath = new Map(existingUndoGroup?.documents.map((document) => [this.keyFor(document.identity), document]) ?? []);
    const records: Array<{ target: VarinDocumentSurfaceOperationPayload['targets'][number]; record: DocumentRecord; hash: string }> = [];
    for (const target of payload.targets) {
      const record = this.records.get(this.keyFor(target.resource));
      const hash = record ? await bufferHash(record.buffer) : '';
      const existingApplied = existingByPath.get(this.keyFor(target.resource));
      const expectedRevision = payload.action === 'undo'
        ? target.expectedAppliedRevision
        : existingApplied?.appliedRevision ?? target.localEditRevision;
      const expectedHash = payload.action === 'undo'
        ? target.expectedAppliedHash
        : existingApplied && target.newText !== undefined
          ? await bufferHash(target.newText)
          : target.bufferHash;
      if (!record || record.status !== 'ready'
        || !this.aliasesFor(record.identity).some((alias) => alias.workspaceId === payload.workspaceId
          && alias.resourceId === target.resource.resourceId)
        || record.connectionGeneration !== this.getGeneration()
        || record.documentInstanceId !== target.documentInstanceId
        || record.baseRevision !== target.baseRevision
        || record.localEditRevision !== expectedRevision
        || hash !== expectedHash
        || record.encoding !== target.encoding || record.bom !== target.bom
        || record.lineEnding !== target.lineEnding
        || this.records.get(this.keyFor(target.resource)) !== record) {
        return this.surfaceOperationFailures(payload, `Document surface binding changed before ${payload.action}`);
      }
      records.push({ target, record, hash });
    }

    if (payload.action === 'capture') {
      return records.map(({ target, record, hash }) => ({
        resource: target.resource,
        status: 'captured',
        documentInstanceId: record.documentInstanceId,
        beforeLocalEditRevision: record.localEditRevision,
        beforeHash: hash,
        content: record.buffer,
      }));
    }

    if (payload.action === 'undo') {
      const undone = this.undoWorkspaceEdit(payload.operationId);
      if (undone.status !== 'undone') {
        const message = undone.status === 'unavailable'
          ? 'The surface undo baseline is unavailable'
          : undone.failures.map((failure) => failure.message).join('; ');
        return this.surfaceOperationFailures(payload, message);
      }
      const targetByKey = new Map(payload.targets.map((target) => [this.keyFor(target.resource), target.resource]));
      return Promise.all(undone.records.map(async (record) => ({
        resource: targetByKey.get(this.keyFor(record.identity)) ?? record.identity,
        status: 'undone' as const,
        documentInstanceId: record.documentInstanceId,
        afterLocalEditRevision: record.localEditRevision,
        afterHash: await bufferHash(record.buffer),
        content: record.buffer,
      })));
    }

    const previous = existingUndoGroup;
    if (previous) {
      const previousByPath = new Map(previous.documents.map((document) => [this.keyFor(document.identity), document]));
      const reusable = records.every(({ target, record }) => {
        const document = previousByPath.get(this.keyFor(target.resource));
        return document && target.newText !== undefined
          && document.appliedBuffer === target.newText
          && document.appliedRevision === record.localEditRevision
          && record.buffer === target.newText;
      }) && previous.documents.length === records.length;
      if (!reusable) {
        return this.surfaceOperationFailures(payload, 'The existing integration undo group no longer matches this operation');
      }
      return Promise.all(records.map(async ({ target, record }) => ({
        resource: target.resource,
        status: 'applied' as const,
        documentInstanceId: record.documentInstanceId,
        beforeLocalEditRevision: target.localEditRevision,
        beforeHash: target.bufferHash,
        afterLocalEditRevision: record.localEditRevision,
        afterHash: await bufferHash(record.buffer),
      })));
    }
    if (records.some(({ target }) => target.newText === undefined)) {
      return this.surfaceOperationFailures(payload, 'Surface text replacement is missing');
    }
    const prepared = await this.prepareWorkspaceEdit({
      workspaceId: payload.workspaceId,
      origin: 'thread-integration',
      groupId: payload.operationId,
      textEdits: records.map(({ target, record }) => ({
        identity: target.resource,
        version: record.localEditRevision,
        edits: [{
          range: { start: { line: 0, character: 0 }, end: endPosition(record.buffer) },
          newText: target.newText!,
        }],
      })),
    });
    if (prepared.status === 'rejected') {
      const message = prepared.failures.map((failure) => failure.message).join('; ');
      return this.surfaceOperationFailures(payload, message);
    }
    const applied = await this.applyWorkspaceEdit(payload.operationId);
    if (applied.status !== 'applied') {
      const message = applied.failures.map((failure) => failure.message).join('; ');
      return this.surfaceOperationFailures(payload, message);
    }
    const beforeByPath = new Map(records.map((entry) => [this.keyFor(entry.target.resource), entry]));
    return Promise.all(applied.records.map(async (record) => {
      const before = beforeByPath.get(this.keyFor(record.identity))!;
      return {
        resource: before.target.resource,
        status: 'applied' as const,
        documentInstanceId: record.documentInstanceId,
        beforeLocalEditRevision: before.record.localEditRevision,
        beforeHash: before.hash,
        afterLocalEditRevision: record.localEditRevision,
        afterHash: await bufferHash(record.buffer),
      };
    }));
  }

  private async surfaceOperationFailures(
    payload: VarinDocumentSurfaceOperationPayload,
    message: string,
  ): Promise<VarinDocumentSurfaceOperationResourceResult[]> {
    return Promise.all(payload.targets.map(async (target) => {
      const record = this.records.get(this.keyFor(target.resource));
      return {
        resource: target.resource,
        status: 'failed' as const,
        message,
        ...(record ? {
          documentInstanceId: record.documentInstanceId,
          afterLocalEditRevision: record.localEditRevision,
          afterHash: await bufferHash(record.buffer),
        } : {}),
      };
    }));
  }

  private scheduleJournal(record: DocumentRecord): void {
    const key = this.keyFor(record.identity);
    const existing = this.journalTimers.get(key);
    if (existing) clearTimeout(existing);
    if (!record.dirty) {
      void this.clearJournal(record).catch((error) => this.reportJournalFailure(error));
      return;
    }
    const generation = record.connectionGeneration;
    this.journalTimers.set(key, setTimeout(() => {
      this.journalTimers.delete(key);
      void this.enqueueJournal(record.identity, () => this.flushJournal(record.identity, generation))
        .catch((error) => this.reportJournalFailure(error));
    }, this.journalDebounceMs));
  }

  private async flushJournal(identity: DocumentIdentity, generation: number): Promise<void> {
    if (this.disposed || generation !== this.getGeneration()) return;
    const record = this.records.get(this.keyFor(identity));
    if (!record?.dirty) return;
    await this.writeJournalRecord(record, true);
  }

  private async writeJournalRecord(record: DocumentRecord, updateRegistry: boolean): Promise<void> {
    const request = {
      token: {
        workspaceId: record.identity.workspaceId,
        epoch: requireWorkspaceEpoch(record.workspaceEpoch),
        owner: {
          kind: 'document-recovery',
          id: this.recoverySessionId,
          generation: record.connectionGeneration,
        },
      },
      workspaceId: record.identity.workspaceId,
      recoverySessionId: this.recoverySessionId,
      resource: record.identity,
      content: serializeEditorContent(record.buffer, record.lineEnding),
      encoding: record.encoding,
      bom: record.bom,
      baseRevision: record.baseRevision,
      expectedRevision: record.recoveryJournalRevision,
    };
    let written = await this.documents.writeRecoveryJournal(request);
    if (written.status === 'stale-epoch') {
      throw new Error(`Workspace epoch changed to ${written.currentEpoch}; recovery journal was not written`);
    }
    if (written.status === 'conflict') {
      written = await this.documents.writeRecoveryJournal({
        ...request,
        expectedRevision: written.journal.revision,
      });
    } else if (written.status === 'missing' && request.expectedRevision !== null) {
      written = await this.documents.writeRecoveryJournal({ ...request, expectedRevision: null });
    }
    if (written.status !== 'written' || !updateRegistry || this.disposed) return;
    const latest = this.records.get(this.keyFor(record.identity));
    if (!latest) return;
    this.commit({
      ...latest,
      recoveryJournalId: written.journal.journalId,
      recoveryJournalRevision: written.journal.revision,
    });
  }

  private async clearJournal(record: DocumentRecord): Promise<void> {
    const timer = this.journalTimers.get(this.keyFor(record.identity));
    if (timer) clearTimeout(timer);
    this.journalTimers.delete(this.keyFor(record.identity));
    await this.enqueueJournal(record.identity, async () => {
      const latest = this.records.get(this.keyFor(record.identity));
      if (!latest?.recoveryJournalId || latest.recoveryJournalRevision === null) return;
      const result = await this.documents.deleteRecoveryJournal({
        token: {
          workspaceId: latest.identity.workspaceId,
          epoch: requireWorkspaceEpoch(latest.workspaceEpoch),
          owner: {
            kind: 'document-recovery',
            id: this.recoverySessionId,
            generation: latest.connectionGeneration,
          },
        },
        journalId: latest.recoveryJournalId,
        expectedRevision: latest.recoveryJournalRevision,
      });
      const current = this.records.get(this.keyFor(record.identity));
      if (!current) return;
      if (result.status === 'stale-epoch') {
        throw new Error(`Workspace epoch changed to ${result.currentEpoch}; recovery journal was not deleted`);
      }
      if (result.status === 'conflict') {
        this.commit({
          ...current,
          recoveryJournalId: result.journal.journalId,
          recoveryJournalRevision: result.journal.revision,
        });
        return;
      }
      this.commit({
        ...current,
        recoveryJournalId: null,
        recoveryJournalRevision: null,
      });
    });
  }

  private enqueueJournal(identity: DocumentIdentity, operation: () => Promise<void>): Promise<void> {
    const key = this.keyFor(identity);
    const previous = this.journalOperations.get(key) ?? Promise.resolve();
    const current = previous.catch((error) => {
      this.reportJournalFailure(error);
    }).then(operation);
    this.journalOperations.set(key, current);
    void current.finally(() => {
      if (this.journalOperations.get(key) === current) this.journalOperations.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private reportJournalFailure(error: unknown): void {
    console.error('[Documents] Failed to persist recovery journal:', error);
  }

  private async restoreJournalIfNeeded(record: DocumentRecord): Promise<void> {
    if (record.dirty) return;
    const runtimeGeneration = this.getGeneration();
    if (runtimeGeneration !== record.connectionGeneration) return;
    type ReadyJournal = Extract<Awaited<ReturnType<DocumentsAPI['readRecoveryJournal']>>, { status: 'ready' }>;
    const candidates: Array<{ alias: DocumentIdentity; epoch: number; loaded: ReadyJournal }> = [];
    const aliases = this.aliasesFor(record.identity);
    let unavailable = false;
    for (const workspaceId of new Set(aliases.map((alias) => alias.workspaceId))) {
      let epoch: number;
      let journals: Awaited<ReturnType<DocumentsAPI['listRecoveryJournals']>>;
      try {
        const workspace = await this.documents.resolveWorkspace({ workspaceId });
        if (workspace.workspaceId !== workspaceId) throw new Error('Recovery workspace identity changed');
        epoch = workspace.epoch;
        journals = await this.documents.listRecoveryJournals({ workspaceId, recoverySessionId: this.recoverySessionId });
      } catch {
        unavailable = true;
        continue;
      }
      for (const alias of aliases.filter((entry) => entry.workspaceId === workspaceId)) {
        const match = journals.find((journal) => journal.resource.workspaceId === workspaceId
          && journal.resource.resourceId === alias.resourceId && journal.epoch === epoch);
        if (!match) continue;
        const loaded = await this.documents.readRecoveryJournal(match.journalId).catch(() => null);
        if (!loaded || loaded.status !== 'ready') {
          unavailable = true;
          continue;
        }
        candidates.push({ alias, epoch, loaded });
      }
    }
    const latest = this.records.get(this.keyFor(record.identity));
    if (this.disposed || this.getGeneration() !== runtimeGeneration || latest !== record || latest.dirty) return;
    if (unavailable) {
      this.commit({
        ...latest,
        errorMessage: 'Recovery drafts through another project path could not be checked. Existing journals were preserved.',
      });
      return;
    }
    if (candidates.length > 1) {
      this.commit({
        ...latest,
        status: 'error',
        errorMessage: 'Multiple recovery drafts refer to this file through different project paths. Review them in Recovery before editing.',
      });
      return;
    }
    const candidate = candidates[0];
    if (!candidate) return;
    const { alias, epoch, loaded } = candidate;
    if (loaded.journal.epoch !== epoch
      || loaded.journal.resource.workspaceId !== alias.workspaceId
      || loaded.journal.resource.resourceId !== alias.resourceId) return;
    const buffer = normalizeEditorLineEndings(loaded.content);
    if (buffer !== latest.baseContent && loaded.journal.baseRevision !== latest.baseRevision) {
      this.commit({
        ...latest,
        status: 'error',
        errorMessage: 'A recovery draft was based on an older disk revision. Review it in Recovery before editing.',
      });
      return;
    }
    const withJournal: DocumentRecord = {
      ...latest,
      identity: alias,
      workspaceEpoch: epoch,
      recoveryJournalId: loaded.journal.journalId,
      recoveryJournalRevision: loaded.journal.revision,
    };
    if (buffer === latest.baseContent) {
      this.commit(withJournal);
      await this.clearJournal(withJournal);
      return;
    }
    this.commit({
      ...withJournal,
      buffer,
      dirty: true,
      localEditRevision: latest.localEditRevision + 1,
      lastOrigin: 'recovery',
      lastChanges: null,
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new DocumentsError('Document registry is disposed', { reason: 'failed' });
  }
}

export const asResource = (identity: DocumentIdentity): VarinResourceReference => identity;
