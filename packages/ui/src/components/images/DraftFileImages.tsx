import React from 'react';
import { ImagePreviewStrip } from './ImagePreviewStrip';
import { ImageViewer } from './ImageViewer';
import { imageUrl, type ImageAnnotationDocument } from '@/lib/images/annotations';
import { useI18n } from '@/lib/i18n';
import type { DraftFileAttachment } from '@/stores/useThreadDraftStore';
import type { ImageAttachment } from '@varin/protocol';

export function DraftFileImages({ files, locked, onRemove, onReference, onUpdate }: {
  files: readonly DraftFileAttachment[]; locked: boolean; onRemove(id: string): void;
  onReference?(reference: number): void;
  onUpdate?(id: string, doc: ImageAnnotationDocument, image?: ImageAttachment): void;
}) {
  const { t } = useI18n();
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const cached = React.useRef(new Map<string, { data: Blob; url: string }>());
  const [preview, setPreview] = React.useState<{ id: string; editing: boolean }>();
  const current = React.useRef({ files, onUpdate, locked }); current.current = { files, onUpdate, locked };
  React.useEffect(() => {
    const entries = cached.current;
    for (const [id, entry] of entries) if (!files.some(file => file.id === id && file.data === entry.data)) {
      URL.revokeObjectURL(entry.url); entries.delete(id);
    }
    for (const file of files) if (!entries.has(file.id)) entries.set(file.id, { data: file.data, url: URL.createObjectURL(file.data.slice(0, file.data.size, file.mimeType)) });
    setUrls(Object.fromEntries([...entries].map(([id, value]) => [id, value.url])));
  }, [files]);
  React.useEffect(() => {
    const entries = cached.current;
    return () => { for (const value of entries.values()) URL.revokeObjectURL(value.url); entries.clear(); };
  }, []);
  const load = React.useCallback(async (source: string) => {
    const file = current.current.files.find(file => file.id === source);
    if (!file) throw new Error('Image removed');
    if (file.annotation) return { src: imageUrl(file.annotation.source) };
    const src = URL.createObjectURL(file.data.slice(0, file.data.size, file.mimeType));
    return { src, release: () => URL.revokeObjectURL(src) };
  }, []);
  const index = files.findIndex(file => file.id === preview?.id);
  return <><ImagePreviewStrip items={files.map(file => ({ id: file.id, src: urls[file.id] ?? '', reference: file.imageReference, edited: Boolean(file.annotation?.marks.length) }))}
    onPreview={(index, editing) => setPreview({ id: files[index]!.id, editing })} editable={!locked && Boolean(onUpdate)}
    onRemove={locked ? undefined : index => onRemove(files[index]!.id)} onReference={locked ? undefined : onReference} removeLabel={t('chat.fileAttachment.actions.removeImage')} />
    {preview && index >= 0 && <ImageViewer initialIndex={index} initiallyEditing={preview.editing} onClose={() => setPreview(undefined)} load={load}
      items={files.map(file => ({ source: file.id, label: t('chat.imageReference.token', { number: file.imageReference ?? 1 }) }))}
      annotation={!locked && onUpdate ? { mode: 'draft', get: id => current.current.files.find(file => file.id === id)?.annotation,
        save: (id, doc) => { if (!current.current.locked) current.current.onUpdate?.(id, doc); },
        apply: (id, image, doc) => { if (!current.current.locked) current.current.onUpdate?.(id, doc, image); },
      } : undefined} />}
  </>;
}
