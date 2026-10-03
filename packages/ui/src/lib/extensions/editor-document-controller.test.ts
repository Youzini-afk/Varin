import { describe, expect, test } from 'vitest';

import type { DocumentRecord } from '@/lib/documents/types';
import { createEditorDocumentController } from './editor-document-controller';

const identity = { workspaceId: 'workspace-1', resourceId: 'src/main.ts' };

const record = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  baseContent: 'let value = 1;',
  baseRevision: 'disk-1',
  bom: false,
  buffer: 'let value = 1;',
  byteLength: 14,
  conflict: null,
  connectionGeneration: 1,
  workspaceEpoch: 1,
  dirty: false,
  documentInstanceId: 'document-1',
  encoding: 'utf-8',
  errorMessage: null,
  externalSource: null,
  identity,
  lastChanges: null,
  lastOrigin: null,
  lineEnding: 'lf',
  localEditRevision: 3,
  recoveryJournalId: null,
  recoveryJournalRevision: null,
  saveCapturedEditRevision: null,
  saveOperationId: null,
  saving: false,
  status: 'ready',
  ...overrides,
});

const registryFor = (current: DocumentRecord, applyEdits: (input: {
  edits: Array<{ from: number; insert: string; to: number }>;
  expectedLocalEditRevision: number;
  origin: string;
}) => unknown) => ({
  applyEdits: (_identity: typeof identity, input: Parameters<typeof applyEdits>[0]) => applyEdits(input),
  get: () => current,
  open: async () => current,
  save: async () => current,
  subscribe: () => () => undefined,
});

describe('custom editor document controller', () => {
  test('projects incremental edits through the registry with the captured version', async () => {
    const current = record();
    let captured: unknown;
    const registry = registryFor(current, (input) => {
      captured = input;
      return { status: 'applied' as const, record: { ...current, localEditRevision: 4, dirty: true } };
    });
    const controller = createEditorDocumentController({ identity, origin: 'editor:custom', registry: registry as never });

    const result = await controller.applyEdits([{ from: 12, to: 13, insert: '2' }], 3);

    expect(result.status).toBe('applied');
    expect(result.snapshot.documentVersion).toBe(4);
    expect(captured).toEqual({
      edits: [{ from: 12, to: 13, insert: '2' }],
      expectedLocalEditRevision: 3,
      origin: 'editor:custom',
    });
  });

  test('returns stale before mutation when the custom view has an old document version', async () => {
    const current = record({ localEditRevision: 5 });
    let calls = 0;
    const registry = registryFor(current, () => {
      calls += 1;
      return { status: 'applied' as const, record: current };
    });
    const controller = createEditorDocumentController({ identity, origin: 'editor:custom', registry: registry as never });

    expect((await controller.applyEdits([{ from: 0, to: 0, insert: 'x' }], 4)).status).toBe('stale');
    expect(calls).toBe(0);
  });

  test('preserves invalid and unsupported registry outcomes', async () => {
    const current = record();
    const invalid = createEditorDocumentController({
      identity,
      origin: 'editor:custom',
      registry: registryFor(current, () => ({ status: 'invalid' as const, reason: 'overlapping-ranges' as const, record: current })) as never,
    });
    expect((await invalid.applyEdits([
      { from: 0, to: 2, insert: 'a' },
      { from: 1, to: 3, insert: 'b' },
    ], 3)).status).toBe('overlapping-ranges');

    const binary = record({ status: 'binary' });
    const unsupported = createEditorDocumentController({
      identity,
      origin: 'editor:custom',
      registry: registryFor(binary, () => ({ status: 'unsupported' as const, record: binary })) as never,
    });
    expect((await unsupported.replaceContent('replacement', 3)).status).toBe('unsupported');

    let deletedCalls = 0;
    const deleted = record({ status: 'deleted' });
    const deletedController = createEditorDocumentController({
      identity,
      origin: 'editor:custom',
      registry: registryFor(deleted, () => {
        deletedCalls += 1;
        return { status: 'applied' as const, record: deleted };
      }) as never,
    });
    expect((await deletedController.applyEdits([{ from: 0, to: 0, insert: 'x' }], 3)).status).toBe('unsupported');
    expect(deletedCalls).toBe(0);
  });

  test('uses one full-range edit for the replaceContent convenience method', async () => {
    const current = record();
    let captured: unknown;
    const registry = registryFor(current, (input) => {
      captured = input;
      return { status: 'applied' as const, record: { ...current, buffer: 'replacement', localEditRevision: 4 } };
    });
    const controller = createEditorDocumentController({ identity, origin: 'editor:custom', registry: registry as never });

    expect((await controller.replaceContent('replacement', 3)).status).toBe('updated');
    expect(captured).toEqual({
      edits: [{ from: 0, insert: 'replacement', to: current.buffer.length }],
      expectedLocalEditRevision: 3,
      origin: 'editor:custom',
    });
  });
});
