import { afterEach, expect, it } from 'vitest';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { beginImageInsertion, removeDraftImage } from './imageAttachments';

afterEach(() => useThreadDraftStore.setState({ drafts: {} }));

it('renumbers current images after deletion and allows a text reference to be removed independently', () => {
  const insertion = beginImageInsertion('draft', null, number => `[图片${number}]`);
  const image = { mimeType: 'image/png', data: 'YQ==' };
  insertion.append(image); insertion.append(image); insertion.append(image);
  removeDraftImage('draft', 1);
  expect(useThreadDraftStore.getState().drafts.draft.text).toBe('[图片1][图片2]');
  insertion.append(image);
  expect(useThreadDraftStore.getState().drafts.draft.images.map(image => image.reference)).toEqual([1, 2, 3]);
  useThreadDraftStore.getState().patch('draft', { text: '自己的说明' });
  expect(useThreadDraftStore.getState().drafts.draft.images).toHaveLength(3);
  insertion.dispose();
});

it('retains restored numbers and starts numbering afresh after an accepted draft is cleared', () => {
  const store = useThreadDraftStore.getState();
  store.patch('draft', { text: '[Image 5]', images: [{ mimeType: 'image/png', data: 'YQ==', reference: 5 }] });
  const insertion = beginImageInsertion('draft', null, number => `[Image ${number}]`);
  insertion.append({ mimeType: 'image/png', data: 'Yg==' });
  expect(useThreadDraftStore.getState().drafts.draft.images.map(image => image.reference)).toEqual([5, 6]);
  store.patch('draft', { text: '', images: [], markerObjects: [], references: [], editorState: undefined });
  insertion.append({ mimeType: 'image/png', data: 'Yg==' });
  expect(useThreadDraftStore.getState().drafts.draft.text).toBe('[Image 1]');
});

it('starts at one again after removing every image without sending', () => {
  const insertion = beginImageInsertion('draft', null, number => `[图片${number}]`);
  const image = { mimeType: 'image/png', data: 'YQ==' };
  insertion.append(image); insertion.append(image);
  removeDraftImage('draft', 0); removeDraftImage('draft', 0);
  expect(useThreadDraftStore.getState().drafts.draft.text).toBe('');
  insertion.append(image);
  expect(useThreadDraftStore.getState().drafts.draft.images[0]!.reference).toBe(1);
  expect(useThreadDraftStore.getState().drafts.draft.text).toBe('[图片1]');
});
