import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftMarkerPreview } from './DraftContentReferences';
import { insertDraftMarker, referenceMarkerObject } from '@/lib/agent-editor/contentReferences';
import { convertDraftImagesToFiles } from '@/lib/agent-runtime/fileAttachments';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import type { ImageAnnotationBinding } from '@/components/images/ImageViewer';
import type { ImageAnnotationDocument } from '@/lib/images/annotations';
const viewer = vi.hoisted(() => ({ annotation: undefined as ImageAnnotationBinding | undefined, source: '' }));
vi.mock('@/lib/i18n', async original => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/images/ImageViewer', () => ({ ImageViewer: (props: { annotation?: ImageAnnotationBinding; items: Array<{source: string}>; initialIndex: number }) => {
  viewer.annotation = props.annotation; viewer.source = props.items[props.initialIndex]!.source;
  return <div role="dialog">Image editor</div>;
} }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <section>{children}</section>, DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>, DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  useThreadDraftStore.setState({ drafts: {} }); viewer.annotation = undefined; viewer.source = '';
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:current-image'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const captured = (id: string) => referenceMarkerObject({ ref: id, title: 'Image', image: { data: 'YQ==', mimeType: 'image/png' },
  source: { kind: 'chat', thread: { runtime: 'agent', threadId: 'source', branchId: 'main' }, itemId: 'original', passages: [] } });
function Preview({ draftKey, id }: { draftKey: string; id: string }) {
  const object = useThreadDraftStore(state => state.drafts[draftKey]?.markerObjects?.find(object => object.id === id));
  return object ? <DraftMarkerPreview object={object} draftKey={draftKey} onClose={() => {}} /> : null;
}
it.each([false, true])('uses the original draft image editor for file=%s and keeps updated pixels bound to its source', async file => {
  await insertDraftMarker('original', captured('original-image'));
  await insertDraftMarker('other', captured('other-image'));
  if (file) convertDraftImagesToFiles('original');
  await act(async () => root.render(<Preview draftKey="original" id="original-image" />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="imageEditor.annotate"]')!.click());
  expect(viewer.annotation?.mode).toBe('draft');
  const binding = viewer.annotation!, source = viewer.source;
  const annotation: ImageAnnotationDocument = { source: { data: 'YQ==', mimeType: 'image/png' }, width: 1, height: 1, marks: [], past: [], future: [] };
  await act(async () => binding.save(source, annotation));
  await act(async () => binding.apply(source, { data: 'ZWRpdGVk', mimeType: 'image/png' }, annotation));
  const original = useThreadDraftStore.getState().drafts.original;
  const payload = original.markerObjects![0]!.payload;
  if (payload.kind === 'file-image') expect(await payload.file.data.text()).toBe('edited');
  else if (payload.kind === 'image') expect(payload.image.data).toBe('ZWRpdGVk');
  else throw new Error('Wrong original image owner');
  expect(payload.contentReference?.source).toMatchObject({ itemId: 'original' });
  expect(original.references?.[0]?.target).toEqual({ kind: 'image', imageId: 'original-image' });
  expect(original.images[0]?.reference ?? original.files?.[0]?.imageReference).toBe(1);
  await act(async () => root.render(<Preview draftKey="other" id="other-image" />));
  await act(async () => binding.apply(source, { data: 'bGF0ZQ==', mimeType: 'image/png' }, annotation));
  expect(useThreadDraftStore.getState().drafts.other.images[0]?.data).toBe('YQ==');
  if (!file) expect(useThreadDraftStore.getState().drafts.original.images[0]?.data).toBe('bGF0ZQ==');
});
