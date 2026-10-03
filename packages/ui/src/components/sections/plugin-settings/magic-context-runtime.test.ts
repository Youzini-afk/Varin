import { describe, expect, test } from 'vitest';
import type { PiSessionEntry } from '@varin/protocol';
import {
  buildMagicContextRuntimeCommand,
  latestMagicContextStatus,
} from './magic-context-runtime';

describe('Magic Context runtime actions', () => {
  test('builds native command invocations and preserves provider confirmation', () => {
    expect(buildMagicContextRuntimeCommand('status')).toEqual({ command: 'ctx-status' });
    expect(buildMagicContextRuntimeCommand('flush')).toEqual({ command: 'ctx-flush' });
    expect(buildMagicContextRuntimeCommand('todos')).toEqual({ command: 'todos' });
    expect(buildMagicContextRuntimeCommand('embedding-status')).toEqual({ command: 'ctx-embed' });
    expect(buildMagicContextRuntimeCommand('embedding-start')).toEqual({ command: 'ctx-embed start' });
    expect(buildMagicContextRuntimeCommand('embedding-pause')).toEqual({ command: 'ctx-embed pause' });
    expect(buildMagicContextRuntimeCommand('augment', { prompt: '  Explain this branch  ' })).toEqual({
      command: 'ctx-aug Explain this branch',
    });
    expect(buildMagicContextRuntimeCommand('wrapup', { messagesToKeep: 32 })).toEqual({
      command: 'ctx-wrapup 32',
    });
    expect(buildMagicContextRuntimeCommand('recomp')).toEqual({ command: 'ctx-recomp' });
    expect(buildMagicContextRuntimeCommand('recomp', {
      recompRange: { end: 11322, start: 1 },
    })).toEqual({ command: 'ctx-recomp 1-11322' });
    expect(buildMagicContextRuntimeCommand('session-upgrade')).toEqual({
      command: 'ctx-session-upgrade',
    });
    expect(buildMagicContextRuntimeCommand('dream', { dreamTask: 'verify' })).toEqual({
      command: 'ctx-dream verify',
    });
    expect(() => buildMagicContextRuntimeCommand('wrapup', { messagesToKeep: 0 })).toThrow();
    expect(() => buildMagicContextRuntimeCommand('augment', { prompt: '   ' })).toThrow();
    expect(() => buildMagicContextRuntimeCommand('recomp', {
      recompRange: { end: 4, start: 5 },
    })).toThrow();
  });

  test('finds the latest valid public ctx-status entry', () => {
    const entries: PiSessionEntry[] = [
      {
        customType: 'ctx-status',
        data: { level: 'info', text: 'older', title: '/ctx-status' },
        id: 'old',
        parentId: null,
        timestamp: '2026-08-03T00:00:00.000Z',
        type: 'custom',
      },
      {
        customType: 'unrelated',
        data: { text: 'ignore', title: 'ignore' },
        id: 'other',
        parentId: 'old',
        timestamp: '2026-08-03T00:00:01.000Z',
        type: 'custom',
      },
      {
        customType: 'ctx-status',
        data: { details: { pendingBefore: 2 }, level: 'success', text: 'flushed', title: '/ctx-flush' },
        id: 'new',
        parentId: 'other',
        timestamp: '2026-08-03T00:00:02.000Z',
        type: 'custom',
      },
    ];

    expect(latestMagicContextStatus(entries)).toEqual({
      entryId: 'new',
      status: {
        details: { pendingBefore: 2 },
        level: 'success',
        text: 'flushed',
        title: '/ctx-flush',
      },
      timestamp: '2026-08-03T00:00:02.000Z',
    });
  });
});
