import { beforeEach, describe, expect, test } from 'vitest';
import type { PiSessionStoreState } from '@/stores/usePiSessionStore';
import { readPiDraft, usePiDraftStore } from '@/stores/usePiDraftStore';
import {
  joinPiDraftInstructions,
  resolveExistingPiSessionDraftTarget,
  stagePiSessionDraft,
} from './sessionDrafts';

const state = (overrides: Partial<PiSessionStoreState>): PiSessionStoreState => ({
  currentSessionId: null,
  records: {},
  summaries: [],
  ...overrides,
} as PiSessionStoreState);

describe('Pi session drafts', () => {
  beforeEach(() => usePiDraftStore.setState({ drafts: {} }));

  test('combines visible workflow context into one hidden instructions block', () => {
    expect(joinPiDraftInstructions(' Resolve the conflict. ', '', undefined, 'Context JSON'))
      .toBe('Resolve the conflict.\n\nContext JSON');
    expect(joinPiDraftInstructions(undefined, '  ')).toBeUndefined();
  });

  test('resolves the active session cwd from the open snapshot, catalog, then fallback', () => {
    expect(resolveExistingPiSessionDraftTarget(state({
      currentSessionId: 'session-1',
      records: {
        'session-1': {
          extensionStates: {},
          open: true,
          sessionId: 'session-1',
          snapshot: { cwd: 'D:/snapshot' } as never,
          toolExecutions: {},
        },
      },
    }), 'D:/fallback')).toEqual({ directory: 'D:/snapshot', sessionKey: 'session-1' });

    expect(resolveExistingPiSessionDraftTarget(state({
      currentSessionId: 'session-2',
      summaries: [{ id: 'session-2', cwd: 'D:/catalog' } as never],
    }), 'D:/fallback')).toEqual({ directory: 'D:/catalog', sessionKey: 'session-2' });

    expect(resolveExistingPiSessionDraftTarget(state({ currentSessionId: 'session-3' }), 'D:/fallback'))
      .toEqual({ directory: 'D:/fallback', sessionKey: 'session-3' });
    expect(resolveExistingPiSessionDraftTarget(state({}), 'D:/fallback')).toBeNull();
  });

  test('stages hidden instructions without discarding attached images', () => {
    usePiDraftStore.getState().setDraft('session-1', {
      images: [{ data: 'image', mimeType: 'image/png' }],
      text: 'Old text',
    });
    stagePiSessionDraft('session-1', {
      instructions: 'Hidden context',
      text: 'Resolve this conflict',
    });
    expect(readPiDraft('session-1')).toEqual({
      images: [{ data: 'image', mimeType: 'image/png' }],
      instructions: 'Hidden context',
      text: 'Resolve this conflict',
    });
  });
});
