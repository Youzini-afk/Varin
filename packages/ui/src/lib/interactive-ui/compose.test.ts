import { undo, redo } from '@codemirror/commands';
import { composerMarkerObjects } from '@/components/chat/composer/editor/markers';
import { afterEach, expect, it } from 'vitest';
import { getRuntimeEndpointGeneration, type ContentReference, type ThreadIdentity } from '@varin/application-client';
import { composeUiResult } from './compose';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { resetEditorContextAttachments } from '@/lib/agent-editor/attachments';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread', branchId: 'branch' };
const reference = (value: string): ContentReference => ({ ref: `ui:choice@snapshot:${value}`, title: 'Choice', text: value,
  source: { kind: 'ui', snapshotRef: `ui:choice@snapshot:${value}`, revisionRef: 'ui:choice@1' } });
afterEach(() => { useThreadDraftStore.setState({ drafts: {} }); resetEditorContextAttachments(); });

it('fills an unmounted original draft, replaces only untouched source text, and preserves edited text and its reference', async () => {
  const key = threadComposerKey(threadHostKey(), identity);
  const otherKey = threadComposerKey(threadHostKey(), { ...identity, branchId: 'other' });
  const images = [{ mimeType: 'image/png', data: 'original' }];
  useThreadDraftStore.getState().patch(key, { text: 'Existing draft', images });
  useThreadDraftStore.getState().patch(otherKey, { text: 'Other branch' });
  const fill = (text: string) => composeUiResult({ identity, host: getRuntimeEndpointGeneration(), sourceKey: 'choice', text, reference: reference(text) });
  expect(await fill('Short')).toEqual({ status: 'filled', updated: false });
  expect(await fill('Long')).toEqual({ status: 'filled', updated: true });
  expect(useThreadDraftStore.getState().drafts[key]?.text).toBe('Existing draft\n\nLong[Reference 1]');
  expect(useThreadDraftStore.getState().drafts[key]?.markerObjects?.flatMap(object => object.payload.kind === 'quote' ? [object.payload.reference.text] : [])).toEqual(['Long']);
  useThreadDraftStore.getState().patch(key, { text: 'Existing draft\n\nMy edited choice' });
  expect(await fill('Curly')).toEqual({ status: 'filled', updated: false });
  expect(useThreadDraftStore.getState().drafts[key]).toMatchObject({ text: 'Existing draft\n\nMy edited choice\n\nCurly[Reference 2]', images });
  expect(useThreadDraftStore.getState().drafts[key]?.markerObjects?.flatMap(object => object.payload.kind === 'quote' ? [object.payload.reference.text] : [])).toEqual(['Long', 'Curly']);
  expect(useThreadDraftStore.getState().drafts[otherKey]?.text).toBe('Other branch');
});

it('restores editable fill and its fixed marker together in one undo/redo step offscreen', async () => {
  const key = threadComposerKey(threadHostKey(), identity);
  useThreadDraftStore.getState().patch(key, { text: 'Original words' });
  await composeUiResult({ identity, host: getRuntimeEndpointGeneration(), sourceKey: 'choice', text: 'My selection', reference: reference('fixed') });
  let state = useThreadDraftStore.getState().drafts[key]!.editorState!;
  const filled = state.doc.toString();
  expect(state.field(composerMarkerObjects)).toHaveLength(1);
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('Original words');
  expect(state.field(composerMarkerObjects)).toEqual([]);
  expect(redo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe(filled);
  expect(state.field(composerMarkerObjects)).toHaveLength(1);
});
