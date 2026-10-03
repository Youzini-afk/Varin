import { beforeEach, describe, expect, test } from 'vitest';
import {
  piDraftKey,
  piPendingDraftKey,
  readPiDraft,
  readPiPendingDraft,
  usePiDraftStore,
} from './usePiDraftStore';

describe('Pi draft store', () => {
  beforeEach(() => usePiDraftStore.setState({ drafts: {} }));

  test('keeps session drafts isolated by runtime and session', () => {
    usePiDraftStore.setState({
      drafts: {
        [piDraftKey('same', 'runtime-a')]: { images: [], text: 'A' },
        [piDraftKey('same', 'runtime-b')]: { images: [], text: 'B' },
      },
    });
    expect(usePiDraftStore.getState().drafts[piDraftKey('same', 'runtime-a')]?.text).toBe('A');
    expect(usePiDraftStore.getState().drafts[piDraftKey('same', 'runtime-b')]?.text).toBe('B');
  });

  test('keeps pending workspace drafts isolated by runtime and cwd', () => {
    const store = usePiDraftStore.getState();
    store.setPendingDraft('/workspace/a', { text: 'Runtime A' }, 'runtime-a');
    store.setPendingDraft('/workspace/a', { text: 'Runtime B' }, 'runtime-b');
    store.setPendingDraft('/workspace/b', { text: 'Workspace B' }, 'runtime-a');

    expect(readPiPendingDraft('/workspace/a', 'runtime-a').text).toBe('Runtime A');
    expect(readPiPendingDraft('/workspace/a', 'runtime-b').text).toBe('Runtime B');
    expect(readPiPendingDraft('/workspace/b', 'runtime-a').text).toBe('Workspace B');
  });

  test('moves only the submitted pending workspace draft to its real session', () => {
    const store = usePiDraftStore.getState();
    store.setDraft('existing-session', { text: 'Existing session draft' }, 'runtime-a');
    store.setPendingDraft('/workspace/a', {
      images: [{ data: 'image', mimeType: 'image/png' }],
      instructions: 'Pending instructions',
      text: 'Pending prompt',
    }, 'runtime-a');
    store.setPendingDraft('/workspace/b', { text: 'Other workspace' }, 'runtime-a');

    const transferred = store.transferPendingDraft('/workspace/a', 'created-session', 'runtime-a');

    expect(transferred).toEqual({
      images: [{ data: 'image', mimeType: 'image/png' }],
      instructions: 'Pending instructions',
      text: 'Pending prompt',
    });
    expect(usePiDraftStore.getState().drafts[piPendingDraftKey('/workspace/a', 'runtime-a')]).toBeUndefined();
    expect(usePiDraftStore.getState().drafts[piDraftKey('created-session', 'runtime-a')]).toEqual(transferred);
    expect(readPiPendingDraft('/workspace/b', 'runtime-a').text).toBe('Other workspace');
    expect(readPiDraft('existing-session', 'runtime-a').text).toBe('Existing session draft');
  });

  test('retains a pending workspace draft until an explicit successful transfer', () => {
    const store = usePiDraftStore.getState();
    store.setPendingDraft('/workspace/retry', { text: 'Retry me' }, 'runtime-a');

    expect(readPiPendingDraft('/workspace/retry', 'runtime-a').text).toBe('Retry me');
    expect(usePiDraftStore.getState().drafts[piDraftKey('not-created', 'runtime-a')]).toBeUndefined();
  });

  test('appends panel context without overwriting existing user text', () => {
    usePiDraftStore.getState().setDraft('session-1', { text: 'User prompt' });
    usePiDraftStore.getState().appendText('session-1', 'Preview annotation');
    expect(readPiDraft('session-1').text).toBe('User prompt\n\nPreview annotation');
  });

  test('clears the complete draft after a successful send', () => {
    usePiDraftStore.getState().setDraft('session-1', {
      agent: {
        description: 'Gather context',
        id: 'scout',
        invocation: { command: 'run', kind: 'slash-command', taskSeparator: 'space' },
        name: 'scout',
        providerId: 'pi-subagents',
      },
      images: [{ data: 'image', mimeType: 'image/png' }],
      instructions: 'Hidden context',
      text: 'Prompt',
    });
    usePiDraftStore.getState().clear('session-1');
    expect(readPiDraft('session-1')).toEqual({ images: [], text: '' });
  });
});
