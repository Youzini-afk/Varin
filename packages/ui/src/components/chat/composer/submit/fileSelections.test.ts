import { beforeEach, expect, test } from 'vitest';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { composerFileSelections, composerHistoryAttachments, removeComposerFile, selectComposerFile } from './fileSelections';
import type { ComposerReference } from '../editor/references';
const host = getRuntimeEndpointGeneration();
const reference: ComposerReference = { id: 'chosen', host, text: '@my file.txt', from: 0, to: 12, target: { kind: 'file', path: 'docs/my file.txt', workspacePath: '/work', sourceKey: 'original' } };
beforeEach(() => useThreadDraftStore.setState({ drafts: {} }));
test('file selection stores no bytes, survives deleting the inline marker, and is removed only by its visible strip', () => {
  selectComposerFile('draft', reference);
  useThreadDraftStore.getState().patch('draft', { text: '', references: [] });
  const files = useThreadDraftStore.getState().drafts.draft.selectedAttachments!;
  expect(files).toEqual([{ id: 'chosen', host, filename: 'my file.txt', sourceKey: 'original', selection: { path: 'docs/my file.txt' } }]);
  expect(composerFileSelections(files, 'original')).toEqual([{ path: 'docs/my file.txt' }]);
  expect(() => composerFileSelections(files, 'replaced')).toThrow('earlier source');
  removeComposerFile('draft', 'chosen');
  expect(useThreadDraftStore.getState().drafts.draft.selectedAttachments).toEqual([]);
});
test('same source path is delivered once and fixed references retain their version across source changes', () => {
  selectComposerFile('draft', reference); selectComposerFile('draft', { ...reference, id: 'again' });
  expect(useThreadDraftStore.getState().drafts.draft.selectedAttachments).toHaveLength(1);
  const attachment = { ref: 'attachment:fixed-version', filename: 'old.txt', mimeType: 'text/plain', byteLength: 7 };
  selectComposerFile('fixed', { ...reference, target: { kind: 'attachment', attachment } });
  expect(composerFileSelections(useThreadDraftStore.getState().drafts.fixed.selectedAttachments, 'new-source')).toEqual([{ ref: attachment.ref }]);
});
test('history candidates use typed public holders, never opaque data or text that resembles a ref', () => {
  const attachment = { ref: 'attachment:real', filename: 'result.txt', mimeType: 'text/plain', byteLength: 7 };
  expect(composerHistoryAttachments([
    { source: 'user', content: { text: 'attachment:pretend', fileAttachments: [attachment] } },
    { source: 'model', content: { content: { kind: 'output', output: { data: { attachment: { ...attachment, ref: 'attachment:opaque' } }, parts: [] } } } },
  ])).toEqual([attachment]);
});

test('removing an old-source file never detaches the same path selected from the new source', () => {
  const newer: ComposerReference = { ...reference, id: 'newer', target: { kind: 'file', path: 'docs/my file.txt', workspacePath: '/other', sourceKey: 'replaced' } };
  selectComposerFile('draft', reference); selectComposerFile('draft', newer);
  useThreadDraftStore.getState().patch('draft', { references: [reference, newer] });
  removeComposerFile('draft', reference.id);
  expect(useThreadDraftStore.getState().drafts.draft.references).toEqual([newer]);
  expect(composerFileSelections(useThreadDraftStore.getState().drafts.draft.selectedAttachments, 'replaced')).toEqual([{ path: 'docs/my file.txt' }]);
});
