import React from 'react';
import { getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { ConversationPreviewContext, useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getOutsideFileGrant, ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { useI18n } from '@/lib/i18n';
import { resolveMarkdownImageSource } from './imageSources';
import { MarkdownImageRegistry, type MarkdownImageAsset, type MarkdownImageItem } from './markdownImages';
import { ImageViewer } from '@/components/images/ImageViewer';
import { ChatTextSourceContext } from '@/components/conversation/chatTextSourceContext';
import { useImageReply } from '@/components/images/useImageReply';

export function useMarkdownImages(containerRef: React.RefObject<HTMLDivElement | null>, onChange?: (reason: 'structural') => void) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const textSource = React.useContext(ChatTextSourceContext);
  const provenance = React.useMemo(() => conversation ? { kind: 'chat' as const, thread: conversation.identity, itemId: textSource?.entryId, passages: [] } : undefined, [conversation, textSource?.entryId]);
  const annotation = useImageReply(undefined, 'image', provenance);
  const preview = React.useContext(ConversationPreviewContext);
  const navigationDirectory = useEffectiveDirectory() ?? '';
  const directory = conversation ? conversation.fileDirectory ?? '' : navigationDirectory;
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const scope = JSON.stringify([generation, conversation?.identity, directory]);
  const [viewer, setViewer] = React.useState<{ items: MarkdownImageItem[]; index: number; scope: string }>();
  const labels = React.useMemo(() => ({ view: t('chat.media.view'), loading: t('chat.media.loading'), retry: t('chat.media.retry'), failed: t('chat.images.failed'), long: t('chat.images.fullLength') }), [t]);
  const registry = React.useRef<MarkdownImageRegistry | null>(null);
  const changed = React.useRef(onChange); changed.current = onChange;
  const load = React.useCallback(async (href: string, signal: AbortSignal, original = false, interactive = false): Promise<MarkdownImageAsset> => {
    const source = resolveMarkdownImageSource(href, directory);
    if (!source || preview) throw new Error('Image source unavailable');
    if (source.kind === 'url') return { src: source.url };
    let grant = getOutsideFileGrant(source.path);
    // Automatic previews never prompt for a new native file grant.
    if ((original || interactive) && !grant) grant = await ensureOutsideFileGrantForDesktop(source.path, directory);
    if (signal.aborted || generation !== getRuntimeEndpointGeneration()) throw new DOMException('Host changed', 'AbortError');
    const response = await runtimeFetch('/api/fs/raw', { query: { path: source.path, directory: directory || undefined,
      ...(original ? {} : { preview: 'image' }), ...(grant ? { allowOutsideWorkspace: true, outsideFileGrant: grant } : {}) }, signal });
    if (!response.ok) throw new Error('Image read failed');
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Not an image');
    if (signal.aborted || generation !== getRuntimeEndpointGeneration()) throw new DOMException('Host changed', 'AbortError');
    const src = URL.createObjectURL(blob);
    return { src, width: Number(response.headers.get('X-Varin-Image-Width')) || undefined,
      height: Number(response.headers.get('X-Varin-Image-Height')) || undefined,
      release: () => URL.revokeObjectURL(src) };
  }, [directory, generation, preview]);
  const loadPreview = React.useCallback((source: string, signal: AbortSignal, interactive?: boolean) => load(source, signal, false, interactive), [load]);
  const loadOriginal = React.useCallback((source: string, signal: AbortSignal) => load(source, signal, true), [load]);
  React.useLayoutEffect(() => {
    const root = containerRef.current; if (!root || preview) return;
    const manager = new MarkdownImageRegistry(root, { labels, load: loadPreview, original: loadOriginal, open: (items, index) => setViewer({ items, index, scope }), changed: () => changed.current?.('structural') });
    registry.current = manager; manager.refresh();
    return () => { manager.cleanup(); if (registry.current === manager) registry.current = null; };
  }, [containerRef, scope, labels, loadPreview, loadOriginal, preview]);
  const refresh = React.useCallback(() => registry.current?.refresh(), []);
  return { labels, refresh, viewer: viewer?.scope === scope ? <ImageViewer annotation={annotation} key={scope + viewer.items.map(item => item.source).join('|') + viewer.index} items={viewer.items} initialIndex={viewer.index} load={loadOriginal} onClose={() => setViewer(current => current === viewer ? undefined : current)} /> : null };
}
