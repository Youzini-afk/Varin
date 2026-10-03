import { describe, expect, test } from 'vitest';
import type { PiRuntimeSnapshot } from '@varin/protocol';
import { shouldApplyPiRuntimeSnapshot } from './snapshot-order';

const snapshot = (revision: number): PiRuntimeSnapshot => ({
  installations: [],
  revision,
  status: 'discovering',
});

describe('Pi runtime snapshot ordering', () => {
  test('accepts the current or a newer authoritative revision', () => {
    expect(shouldApplyPiRuntimeSnapshot(4, snapshot(4))).toBe(true);
    expect(shouldApplyPiRuntimeSnapshot(4, snapshot(5))).toBe(true);
  });

  test('rejects a delayed snapshot older than the latest event', () => {
    expect(shouldApplyPiRuntimeSnapshot(5, snapshot(4))).toBe(false);
  });
});
