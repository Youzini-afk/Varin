import { describe, expect, test } from 'vitest';
import type { DocumentRecord } from '@/lib/documents/types';
import { applyDocumentCodeMirrorChanges } from './DocumentCodeMirror';

const identity = { workspaceId: 'workspace', resourceId: 'src/main.ts' };

const record = (revision: number, status: DocumentRecord['status'] = 'ready'): DocumentRecord => ({
  identity,
  documentInstanceId: 'document-1',
  connectionGeneration: 1,
  workspaceEpoch: 1,
  status,
  dirty: false,
  saving: false,
  baseContent: 'const value = 1;',
  buffer: 'const value = 1;',
  baseRevision: 'disk-1',
  localEditRevision: revision,
  encoding: 'utf-8',
  bom: false,
  lineEnding: 'lf',
  byteLength: 16,
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

describe('DocumentCodeMirror adapter', () => {
  test('submits offset edits with the current local revision', () => {
    const current = record(4);
    let request: unknown;
    const registry = {
      get: () => current,
      applyEdits: (_identity: typeof identity, input: unknown) => {
        request = input;
        return { status: 'applied' as const, record: current };
      },
    };

    const result = applyDocumentCodeMirrorChanges(
      registry,
      identity,
      [{ from: 13, to: 14, insert: '2' }],
      'mobile:view',
      4,
    );

    expect(result.status).toBe('applied');
    expect(request).toEqual({
      expectedLocalEditRevision: 4,
      edits: [{ from: 13, to: 14, insert: '2' }],
      origin: 'mobile:view',
    });
  });

  test('preserves stale results without retrying or changing the buffer', () => {
    const current = record(2);
    let calls = 0;
    const registry = {
      get: () => current,
      applyEdits: () => {
        calls += 1;
        return {
          status: 'stale' as const,
          record: current,
          expectedLocalEditRevision: 1,
          actualLocalEditRevision: 2,
        };
      },
    };

    const result = applyDocumentCodeMirrorChanges(
      registry,
      identity,
      [{ from: 0, to: 0, insert: 'x' }],
      'mobile:view',
      1,
    );

    expect(result.status).toBe('stale');
    expect(calls).toBe(1);
    expect(current.buffer).toBe('const value = 1;');
  });

  test('returns explicit unsupported when no incremental changes are available', () => {
    const current = record(0);
    const registry = {
      get: () => current,
      applyEdits: () => ({ status: 'applied' as const, record: current }),
    };

    expect(applyDocumentCodeMirrorChanges(registry, identity, undefined, 'mobile:view', 0)).toEqual({
      status: 'unsupported',
      reason: 'missing-changes',
      record: current,
    });
  });

  test('preserves registry unsupported results for binary or unsupported encodings', () => {
    const current = record(0, 'binary');
    const registry = {
      get: () => current,
      applyEdits: () => ({ status: 'unsupported' as const, record: current }),
    };

    expect(applyDocumentCodeMirrorChanges(
      registry,
      identity,
      [{ from: 0, to: 0, insert: 'x' }],
      'mobile:view',
      0,
    )).toEqual({
      status: 'unsupported',
      record: current,
    });
  });
});
