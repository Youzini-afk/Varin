import type { editor } from 'monaco-editor/editor';

import type { DocumentRegistry } from '@/lib/documents/registry';
import type { DocumentChange, DocumentIdentity, DocumentRecord } from '@/lib/documents/types';
import { markMonacoPerformance } from './performance';
import { loadMonacoRuntime, type MonacoRuntime } from './runtime';

export type FileEditorModelSyncFailure = {
  actualLocalEditRevision: number;
  expectedLocalEditRevision: number;
  modelContent: string;
  reason: 'invalid' | 'stale' | 'unsupported';
  registryContent: string;
};

export type FileEditorModelSnapshot =
  | { status: 'loading'; model: null; syncFailure: null }
  | { status: 'ready'; model: editor.ITextModel; syncFailure: FileEditorModelSyncFailure | null }
  | { status: 'unsupported'; model: null; syncFailure: null }
  | { status: 'failed'; model: null; syncFailure: FileEditorModelSyncFailure | null; errorMessage: string };

type ModelEntry = {
  applyingRegistryUpdate: boolean;
  key: string;
  retired: boolean;
  identity: DocumentIdentity;
  documentInstanceId: string | null;
  documentSubscription: (() => void) | null;
  listeners: Set<() => void>;
  loading: Promise<void> | null;
  model: editor.ITextModel | null;
  modelSubscription: { dispose(): void } | null;
  owners: Set<string>;
  record: DocumentRecord | null;
  snapshot: FileEditorModelSnapshot;
};

type FileEditorModelRegistryOptions = {
  documents: DocumentRegistry;
  loadRuntime?: () => Promise<MonacoRuntime>;
  runtimeKey: string;
};

const LOADING_SNAPSHOT: FileEditorModelSnapshot = {
  status: 'loading',
  model: null,
  syncFailure: null,
};

const runtimeAuthority = (runtimeKey: string): string => {
  const bytes = new TextEncoder().encode(runtimeKey);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `r-${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
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

export class FileEditorModelRegistry {
  private readonly documents: DocumentRegistry;
  private readonly loadRuntime: () => Promise<MonacoRuntime>;
  private readonly runtimeKey: string;
  private readonly entriesByIdentity = new Map<string, ModelEntry>();
  private readonly owners = new Map<string, ModelEntry>();
  private readonly pendingListeners = new Map<string, Set<() => void>>();
  private disposed = false;

  constructor(options: FileEditorModelRegistryOptions) {
    this.documents = options.documents;
    this.loadRuntime = options.loadRuntime ?? loadMonacoRuntime;
    this.runtimeKey = options.runtimeKey;
  }

  private keyFor(identity: DocumentIdentity): string {
    return this.documents.keyFor(identity);
  }

  acquire(identity: DocumentIdentity, ownerId: string): void {
    this.assertActive();
    const previous = this.owners.get(ownerId);
    if (previous && this.keyFor(previous.identity) === this.keyFor(identity)) return;
    if (previous) this.release(ownerId);
    const entry = this.ensureEntry(identity);
    entry.owners.add(ownerId);
    this.owners.set(ownerId, entry);
    void this.documents.open(identity).then((record) => {
      if (!this.disposed && entry.owners.size > 0) this.handleRecord(entry, record);
    }).catch((error) => {
      if (!this.disposed) this.publish(entry, {
        status: 'failed',
        model: null,
        syncFailure: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }

  release(ownerId: string): void {
    const entry = this.owners.get(ownerId);
    if (!entry) return;
    this.owners.delete(ownerId);
    entry.owners.delete(ownerId);
    if (entry.owners.size === 0 && entry.record?.dirty !== true) this.disposeEntry(entry);
  }

  subscribe(identity: DocumentIdentity, listener: () => void): () => void {
    const key = this.keyFor(identity);
    const entry = this.entriesByIdentity.get(key);
    const listeners = entry?.listeners ?? this.pendingListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    if (!entry) this.pendingListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      this.entriesByIdentity.get(this.keyFor(identity))?.listeners.delete(listener);
      if (!entry && listeners.size === 0) this.pendingListeners.delete(key);
    };
  }

  getSnapshot(identity: DocumentIdentity): FileEditorModelSnapshot {
    return this.entriesByIdentity.get(this.keyFor(identity))?.snapshot ?? LOADING_SNAPSHOT;
  }

  getRecordForModel(model: editor.ITextModel): DocumentRecord | undefined {
    for (const entry of this.entriesByIdentity.values()) {
      if (entry.model === model) return entry.record ?? undefined;
    }
    return undefined;
  }

  retry(identity: DocumentIdentity): void {
    const entry = this.entriesByIdentity.get(this.keyFor(identity));
    if (!entry || entry.model || entry.loading) return;
    this.publish(entry, LOADING_SNAPSHOT);
    this.ensureModel(entry);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const entries = new Set(this.entriesByIdentity.values());
    this.entriesByIdentity.clear();
    this.owners.clear();
    this.pendingListeners.clear();
    for (const entry of entries) this.disposeEntry(entry, false);
  }

  private ensureEntry(identity: DocumentIdentity): ModelEntry {
    const key = this.keyFor(identity);
    const existing = this.entriesByIdentity.get(key);
    if (existing) return existing;
    const entry: ModelEntry = {
      applyingRegistryUpdate: false,
      key,
      retired: false,
      identity,
      documentInstanceId: null,
      documentSubscription: null,
      listeners: this.pendingListeners.get(key) ?? new Set(),
      loading: null,
      model: null,
      modelSubscription: null,
      owners: new Set(),
      record: null,
      snapshot: LOADING_SNAPSHOT,
    };
    this.pendingListeners.delete(key);
    entry.documentSubscription = this.documents.subscribe(identity, (record) => this.handleRecord(entry, record));
    this.entriesByIdentity.set(key, entry);
    const record = this.documents.get(identity);
    if (record) this.handleRecord(entry, record);
    return entry;
  }

  private handleRecord(entry: ModelEntry, record: DocumentRecord): void {
    if (this.disposed || entry.retired) return;
    const previousKey = entry.key;
    const nextKey = this.keyFor(record.identity);
    if (previousKey !== nextKey) {
      const shared = this.entriesByIdentity.get(nextKey);
      if (shared && shared !== entry) {
        for (const owner of entry.owners) {
          shared.owners.add(owner);
          this.owners.set(owner, shared);
        }
        entry.owners.clear();
        for (const listener of entry.listeners) shared.listeners.add(listener);
        entry.listeners.clear();
        if (this.entriesByIdentity.get(previousKey) === entry) this.entriesByIdentity.delete(previousKey);
        this.disposeEntry(entry, false);
        this.handleRecord(shared, record);
        for (const listener of shared.listeners) listener();
        return;
      }
      if (this.entriesByIdentity.get(previousKey) === entry) this.entriesByIdentity.delete(previousKey);
      this.entriesByIdentity.set(nextKey, entry);
      entry.key = nextKey;
      entry.identity = record.identity;
    }
    entry.record = record;
    entry.documentInstanceId = record.documentInstanceId;

    if (record.status === 'binary' || record.status === 'unsupported-encoding') {
      this.disposeModel(entry);
      this.publish(entry, { status: 'unsupported', model: null, syncFailure: null });
      return;
    }
    if (record.status === 'error' && !entry.model) {
      this.publish(entry, {
        status: 'failed',
        model: null,
        syncFailure: null,
        errorMessage: record.errorMessage ?? 'Document loading failed.',
      });
      return;
    }
    if (record.status === 'unloaded' || record.status === 'loading') return;
    if (!entry.model) {
      this.ensureModel(entry);
      return;
    }

    const edit = replacementBetween(entry.model.getValue(), record.buffer);
    if (edit) {
      const from = entry.model.getPositionAt(edit.from);
      const to = entry.model.getPositionAt(edit.to);
      entry.applyingRegistryUpdate = true;
      try {
        entry.model.pushEditOperations(null, [{
          range: {
            startLineNumber: from.lineNumber,
            startColumn: from.column,
            endLineNumber: to.lineNumber,
            endColumn: to.column,
          },
          text: edit.insert,
        }], () => null);
      } finally {
        entry.applyingRegistryUpdate = false;
      }
    }
    if (entry.snapshot.status === 'ready') {
      this.publish(entry, { ...entry.snapshot, syncFailure: null });
    }
    if (entry.owners.size === 0 && !record.dirty) this.disposeEntry(entry);
  }

  private ensureModel(entry: ModelEntry): void {
    if (entry.loading || entry.model || !entry.record) return;
    const expectedInstanceId = entry.record.documentInstanceId;
    entry.loading = this.loadRuntime().then((monaco) => {
      if (
        this.disposed
        || entry.retired
        || entry.documentInstanceId !== expectedInstanceId
        || (!entry.record?.dirty && entry.owners.size === 0)
      ) return;
      const record = entry.record;
      if (!record) return;
      const uri = monaco.Uri.from({
        scheme: 'varin-document',
        authority: runtimeAuthority(this.runtimeKey),
        path: `/${expectedInstanceId}`,
      });
      const model = monaco.editor.createModel(record.buffer, 'plaintext', uri);
      entry.model = model;
      entry.modelSubscription = model.onDidChangeContent((event) => this.handleModelChange(entry, event));
      this.publish(entry, { status: 'ready', model, syncFailure: null });
      markMonacoPerformance('editor.model.ready');
    }).catch((error) => {
      if (this.disposed) return;
      this.publish(entry, {
        status: 'failed',
        model: null,
        syncFailure: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      entry.loading = null;
    });
  }

  private handleModelChange(
    entry: ModelEntry,
    event: editor.IModelContentChangedEvent,
  ): void {
    if (this.disposed || entry.applyingRegistryUpdate || !entry.model || !entry.record) return;
    const expectedLocalEditRevision = entry.record.localEditRevision;
    const changes = event.changes.map((change) => ({
      from: change.rangeOffset,
      to: change.rangeOffset + change.rangeLength,
      insert: change.text,
    }));
    const result = this.documents.applyEdits(entry.identity, {
      expectedLocalEditRevision,
      edits: changes,
      origin: `monaco:${entry.documentInstanceId ?? 'pending'}`,
    });
    if (result.status === 'applied') {
      entry.record = result.record;
      if (entry.snapshot.status === 'ready' && entry.snapshot.syncFailure) {
        this.publish(entry, { ...entry.snapshot, syncFailure: null });
      }
      return;
    }

    const modelContent = entry.model.getValue();
    const failure: FileEditorModelSyncFailure = {
      actualLocalEditRevision: result.record.localEditRevision,
      expectedLocalEditRevision,
      modelContent,
      reason: result.status,
      registryContent: result.record.buffer,
    };
    // Keep the user's already-applied editor input recoverable. The captured registry snapshot remains
    // attached to the binding failure for diagnostics; the ordinary document conflict state still owns
    // any disk/Agent candidate.
    const recovered = this.documents.applyTransaction(entry.identity, modelContent, {
      origin: `monaco-recovery:${entry.documentInstanceId ?? 'pending'}`,
      changes,
    });
    entry.record = recovered;
    this.publish(entry, { status: 'ready', model: entry.model, syncFailure: failure });
  }

  private publish(entry: ModelEntry, snapshot: FileEditorModelSnapshot): void {
    if (entry.snapshot === snapshot) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }

  private disposeModel(entry: ModelEntry): void {
    entry.modelSubscription?.dispose();
    entry.modelSubscription = null;
    entry.model?.dispose();
    entry.model = null;
  }

  private disposeEntry(entry: ModelEntry, removeFromIndex = true): void {
    entry.retired = true;
    for (const owner of entry.owners) this.owners.delete(owner);
    entry.owners.clear();
    entry.documentSubscription?.();
    entry.documentSubscription = null;
    this.disposeModel(entry);
    if (removeFromIndex) {
      const key = entry.key;
      if (this.entriesByIdentity.get(key) === entry) this.entriesByIdentity.delete(key);
    }
    for (const listener of entry.listeners) listener();
    entry.listeners.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('File editor model registry is disposed.');
  }
}
