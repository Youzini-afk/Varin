import { describe, expect, test } from 'bun:test';
import type { editor } from 'monaco-editor/editor';

import type { DocumentRegistry } from '@/lib/documents/registry';
import {
  documentKey,
  type DocumentEditResult,
  type DocumentIdentity,
  type DocumentRecord,
} from '@/lib/documents/types';
import { FileEditorModelRegistry } from './model-registry';
import type { MonacoRuntime } from './runtime';

const identity = (resourceId = 'src/file.ts'): DocumentIdentity => ({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId,
});

const record = (resource: DocumentIdentity, buffer = 'const value = 1;'): DocumentRecord => ({
  identity: resource,
  documentInstanceId: 'document-one',
  connectionGeneration: 1,
  workspaceEpoch: 1,
  status: 'ready',
  dirty: false,
  saving: false,
  baseContent: buffer,
  buffer,
  baseRevision: 'disk-one',
  localEditRevision: 0,
  encoding: 'utf-8',
  bom: false,
  lineEnding: 'lf',
  byteLength: buffer.length,
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

class FakeDocuments {
  current: DocumentRecord;
  forceStale = false;
  private readonly listeners = new Set<(record: DocumentRecord) => void>();

  constructor(initial: DocumentRecord) {
    this.current = initial;
  }

  keyFor(resource: DocumentIdentity): string {
    return documentKey(resource);
  }

  get(resource: DocumentIdentity): DocumentRecord | undefined {
    return documentKey(resource) === documentKey(this.current.identity) ? this.current : undefined;
  }

  async open(): Promise<DocumentRecord> {
    return this.current;
  }

  subscribe(_resource: DocumentIdentity, listener: (record: DocumentRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyEdits(_resource: DocumentIdentity, input: {
    expectedLocalEditRevision: number;
    edits: Array<{ from: number; to: number; insert: string }>;
    origin: string;
  }): DocumentEditResult {
    if (this.forceStale || input.expectedLocalEditRevision !== this.current.localEditRevision) {
      return {
        status: 'stale',
        record: this.current,
        expectedLocalEditRevision: input.expectedLocalEditRevision,
        actualLocalEditRevision: this.current.localEditRevision,
      };
    }
    let buffer = this.current.buffer;
    const changes = [...input.edits].sort((left, right) => right.from - left.from);
    for (const edit of changes) buffer = `${buffer.slice(0, edit.from)}${edit.insert}${buffer.slice(edit.to)}`;
    this.current = {
      ...this.current,
      buffer,
      dirty: buffer !== this.current.baseContent,
      localEditRevision: this.current.localEditRevision + 1,
      lastChanges: changes,
      lastOrigin: input.origin,
    };
    this.emit();
    return { status: 'applied', record: this.current };
  }

  applyTransaction(_resource: DocumentIdentity, buffer: string, options: { origin: string; changes?: Array<{ from: number; to: number; insert: string }> }): DocumentRecord {
    this.current = {
      ...this.current,
      buffer,
      dirty: buffer !== this.current.baseContent,
      localEditRevision: this.current.localEditRevision + 1,
      lastChanges: options.changes ?? null,
      lastOrigin: options.origin,
    };
    this.emit();
    return this.current;
  }

  replace(next: DocumentRecord): void {
    this.current = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

type FakeChange = { from: number; to: number; insert: string };

class FakeModel {
  disposed = false;
  readonly uri: unknown;
  private value: string;
  private readonly listeners = new Set<(event: editor.IModelContentChangedEvent) => void>();

  constructor(value: string, uri: unknown) {
    this.value = value;
    this.uri = uri;
  }

  getValue(): string {
    return this.value;
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.value.slice(0, offset);
    const lines = before.split('\n');
    return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
  }

  onDidChangeContent(listener: (event: editor.IModelContentChangedEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  pushEditOperations(
    _beforeCursorState: unknown,
    operations: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string | null }>,
  ): null {
    const changes = operations.map((operation) => ({
      from: this.offsetAt(operation.range.startLineNumber, operation.range.startColumn),
      to: this.offsetAt(operation.range.endLineNumber, operation.range.endColumn),
      insert: operation.text ?? '',
    }));
    this.apply(changes);
    return null;
  }

  simulateInput(changes: FakeChange[]): void {
    this.apply(changes);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private offsetAt(lineNumber: number, column: number): number {
    const lines = this.value.split('\n');
    let offset = 0;
    for (let index = 0; index < lineNumber - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
    return offset + column - 1;
  }

  private apply(changes: FakeChange[]): void {
    const previous = this.value;
    const descending = [...changes].sort((left, right) => right.from - left.from);
    for (const change of descending) {
      this.value = `${this.value.slice(0, change.from)}${change.insert}${this.value.slice(change.to)}`;
    }
    const event = {
      changes: changes.map((change) => ({
        range: {} as never,
        rangeLength: change.to - change.from,
        rangeOffset: change.from,
        text: change.insert,
      })),
      eol: '\n',
      isFlush: false,
      isRedoing: false,
      isUndoing: false,
      versionId: previous === this.value ? 0 : 1,
    } as unknown as editor.IModelContentChangedEvent;
    for (const listener of this.listeners) listener(event);
  }
}

const fakeRuntime = (models: FakeModel[]): MonacoRuntime => ({
  Uri: {
    from: (components: unknown) => components,
  },
  editor: {
    createModel: (value: string, _language?: string, uri?: unknown) => {
      const model = new FakeModel(value, uri);
      models.push(model);
      return model;
    },
  },
} as unknown as MonacoRuntime);

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('FileEditorModelRegistry', () => {
  test('shares one model across owners and applies incremental model input once', async () => {
    const documents = new FakeDocuments(record(identity()));
    const models: FakeModel[] = [];
    const registry = new FileEditorModelRegistry({
      documents: documents as unknown as DocumentRegistry,
      loadRuntime: async () => fakeRuntime(models),
      runtimeKey: 'local',
    });
    registry.acquire(identity(), 'tab:a');
    registry.acquire(identity(), 'tab:b');
    await settle();

    expect(models.length).toBe(1);
    models[0].simulateInput([{ from: 6, to: 11, insert: 'answer' }]);
    expect(documents.current.buffer).toBe('const answer = 1;');
    expect(documents.current.localEditRevision).toBe(1);
    expect(registry.getSnapshot(identity()).status).toBe('ready');

    registry.release('tab:a');
    expect(models[0].disposed).toBe(false);
    registry.release('tab:b');
    expect(models[0].disposed).toBe(false);
    documents.replace({ ...documents.current, dirty: false, baseContent: documents.current.buffer });
    expect(models[0].disposed).toBe(true);
    registry.dispose();
  });

  test('projects external registry edits without feeding them back as user input', async () => {
    const documents = new FakeDocuments(record(identity()));
    const models: FakeModel[] = [];
    const registry = new FileEditorModelRegistry({
      documents: documents as unknown as DocumentRegistry,
      loadRuntime: async () => fakeRuntime(models),
      runtimeKey: 'local',
    });
    registry.acquire(identity(), 'tab:a');
    await settle();

    documents.replace({
      ...documents.current,
      baseContent: 'const value = 2;',
      buffer: 'const value = 2;',
      baseRevision: 'disk-two',
    });
    expect(models[0].getValue()).toBe('const value = 2;');
    expect(documents.current.localEditRevision).toBe(0);
    registry.dispose();
  });

  test('keeps both snapshots visible when a stale model change requires recovery', async () => {
    const documents = new FakeDocuments(record(identity()));
    const models: FakeModel[] = [];
    const registry = new FileEditorModelRegistry({
      documents: documents as unknown as DocumentRegistry,
      loadRuntime: async () => fakeRuntime(models),
      runtimeKey: 'local',
    });
    registry.acquire(identity(), 'tab:a');
    await settle();
    documents.forceStale = true;
    models[0].simulateInput([{ from: 16, to: 16, insert: '\n' }]);

    const snapshot = registry.getSnapshot(identity());
    expect(snapshot.status).toBe('ready');
    if (snapshot.status === 'ready') {
      expect(snapshot.syncFailure?.reason).toBe('stale');
      expect(snapshot.syncFailure?.registryContent).toBe('const value = 1;');
      expect(snapshot.syncFailure?.modelContent).toBe('const value = 1;\n');
    }
    expect(documents.current.buffer).toBe('const value = 1;\n');
    registry.dispose();
  });

  test('preserves model identity when the document moves', async () => {
    const before = identity('src/before.ts');
    const after = identity('src/after.ts');
    const documents = new FakeDocuments(record(before));
    const models: FakeModel[] = [];
    const registry = new FileEditorModelRegistry({
      documents: documents as unknown as DocumentRegistry,
      loadRuntime: async () => fakeRuntime(models),
      runtimeKey: 'url:https://host.example',
    });
    registry.acquire(before, 'tab:a');
    await settle();
    const model = models[0];

    documents.replace({ ...documents.current, identity: after });
    expect(registry.getSnapshot(after)).toEqual({ status: 'ready', model, syncFailure: null });
    expect(model.uri).toEqual({
      scheme: 'varin-document',
      authority: 'r-dXJsOmh0dHBzOi8vaG9zdC5leGFtcGxl',
      path: '/document-one',
    });
    registry.dispose();
  });

  test('keeps a runtime failure local and retries without replacing the document record', async () => {
    const resource = identity();
    const initial = record(resource);
    const documents = new FakeDocuments(initial);
    const models: FakeModel[] = [];
    let attempts = 0;
    const registry = new FileEditorModelRegistry({
      documents: documents as unknown as DocumentRegistry,
      loadRuntime: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('worker unavailable');
        return fakeRuntime(models);
      },
      runtimeKey: 'local',
    });
    registry.acquire(resource, 'tab:a');
    await settle();
    expect(registry.getSnapshot(resource)).toEqual({
      status: 'failed',
      model: null,
      syncFailure: null,
      errorMessage: 'worker unavailable',
    });
    expect(documents.current).toBe(initial);

    registry.retry(resource);
    await settle();
    expect(registry.getSnapshot(resource).status).toBe('ready');
    expect(models.length).toBe(1);
    registry.dispose();
  });
});
