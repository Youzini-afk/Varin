import { describe, expect, test } from 'vitest';

import type { MonacoRuntime } from './runtime';
import {
  acquireMonacoDiffSnapshotModel,
  monacoDiffContentRevision,
} from './diff-model-registry';

describe('Monaco diff snapshot identity', () => {
  test('is stable for equal content and changes when either content or length changes', () => {
    expect(monacoDiffContentRevision('before')).toBe(monacoDiffContentRevision('before'));
    expect(monacoDiffContentRevision('before')).not.toBe(monacoDiffContentRevision('after'));
    expect(monacoDiffContentRevision('a')).not.toBe(monacoDiffContentRevision('aa'));
  });

  test('shares one immutable snapshot until the last visible owner releases it', () => {
    let created = 0;
    let disposed = 0;
    const monaco = {
      Uri: {
        from: (value: unknown) => ({ toString: () => JSON.stringify(value) }),
      },
      editor: {
        createModel: () => {
          created += 1;
          return { dispose: () => { disposed += 1; } };
        },
      },
    } as unknown as MonacoRuntime;
    const input = {
      content: 'const value = 1;',
      languageId: 'typescript',
      revision: 'git:abc',
      side: 'original' as const,
      viewId: 'view-a',
    };
    const first = acquireMonacoDiffSnapshotModel(monaco, { ...input, ownerId: 'owner-a' });
    const second = acquireMonacoDiffSnapshotModel(monaco, { ...input, ownerId: 'owner-b' });
    expect(first.model).toBe(second.model);
    expect(created).toBe(1);
    first.release();
    expect(disposed).toBe(0);
    second.release();
    expect(disposed).toBe(1);
  });
});
