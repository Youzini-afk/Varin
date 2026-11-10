import React from 'react';
import { ChatTextSourceContext } from './chatTextSourceContext';
import type { ChatSessionMessageEntry } from './types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, type ContentReference, type ChatMemoryPassage } from '@varin/application-client';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { ConversationImageViewer } from '@/components/images/ConversationImage';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useConversationPresentation } from './ConversationContext';
import { captureMarkdownImageReader } from '@/components/chat/markdown/markdownImages';
import { captureChatSelection, captureChatSourceBlock, chatTextSourceOffset, type ChatTextSource as ChatSourceData } from './chatSelection';
import { ChatMemoryDialog } from './ChatMemoryDialog';
import { resolveChatTimelineItem, type ChatTimelineProjection } from './chatTimelineProjection';
import type { ChatTimelineProps } from './ChatTimelineEntries';
import { captureAssistantTurn } from './chatQuoteCapture';
import { captureChatQuoteObject, captureChatQuoteGroup, addChatObjectReference } from './chatQuoteObjects';
import { addContentReference, beginContentReferenceInsertion } from '@/lib/agent-editor/attachments';
import { ReferenceNavigationContext } from './ReferenceNavigation';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { ChatFileMenu } from './ChatFileMenu';
import { ChatFileTargetsContext, type ChatFileTarget } from './chatFileTargets';
const BotHandoffDialog = React.lazy(() => import('@/components/sections/bots/BotHandoffDialog').then(module => ({ default: module.BotHandoffDialog })));

const SOURCE_LINK = '#varin-chat-source:';
export const CHAT_QUOTE_EVENT = 'varin:chat-quote';

const ChatActionsContext = React.createContext<{
  sources: Map<HTMLElement, ChatSourceData>;
  resolve(source: ChatSourceData): ChatSourceData;
  more(element: HTMLElement): void;
} | null>(null);

export { ChatTextSourceContext } from './chatTextSourceContext';
export const ChatTextSource: React.FC<ChatSourceData & { children: React.ReactNode; role?: string; contentIdentity?: string }> = ({ children, entryId, text, offset, contentIndex, role, contentIdentity, streaming }) => {
  const context = React.useContext(ChatActionsContext);
  const resolved = context?.resolve({ entryId, text, offset, contentIndex, role, contentIdentity, streaming }) ?? { entryId, text, offset, contentIndex, role, contentIdentity, streaming };
  offset = resolved.offset; entryId = resolved.entryId;
  const previous = React.useRef<HTMLDivElement | null>(null);
  const attach = React.useCallback((element: HTMLDivElement | null) => {
    if (previous.current) context?.sources.delete(previous.current);
    previous.current = element;
    if (element) context?.sources.set(element, { entryId, text, offset, contentIndex, role, contentIdentity, streaming });
  }, [contentIndex, context, entryId, offset, text, role, contentIdentity, streaming]);
  return <ChatTextSourceContext.Provider value={{ entryId, text, offset, contentIndex, role, contentIdentity, streaming }}><div ref={attach} className="contents" data-conversation-chat-source data-conversation-source-id={entryId} data-conversation-source-offset={offset}>{children}</div></ChatTextSourceContext.Provider>;
};

export const ChatMoreButton: React.FC = () => {
  const context = React.useContext(ChatActionsContext);
  const { t } = useI18n();
  if (!context) return null;
  return <button type="button" data-chat-more aria-label={t('chat.context.more')} title={t('chat.context.more')}
    className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
    onClick={(event) => context.more(event.currentTarget)}><Icon name="more" className="size-3.5" /></button>;
};

interface MenuTarget {
  kind: 'selection' | 'user' | 'turn' | 'block' | 'code' | 'link' | 'file' | 'image' | 'object' | 'group';
  text: string;
  copyText?: string;
  entry?: ChatSessionMessageEntry;
  sourceEntryId?: string;
  href?: string;
  element?: HTMLElement;
  selection?: Range;
  passages?: ChatMemoryPassage[];
  complete?: boolean;
  runtimeKey: string;
  file?: ChatFileTarget;
  reference?: ContentReference;
  references?: ContentReference[];
  turn?: ReturnType<typeof captureAssistantTurn>;
  identity: import('@varin/application-client').ThreadIdentity;
  title?: string;
  sourceRole?: 'user' | 'assistant' | 'tool';
  streaming?: boolean;
  capturedAt: string;
  readImageOriginal?: ReturnType<typeof captureMarkdownImageReader>;

}

export const ChatContextMenu: React.FC<Pick<ChatTimelineProps,
  'sessionId' | 'entries' | 'onFork' | 'onOpenThread' | 'onRecover' | 'forkBusyEntryId' | 'threadBusyEntryId' | 'recoveryBusyEntryId'
> & { projection: ChatTimelineProjection; children: React.ReactNode; onRevealEntry(entryId: string): void | Promise<void> }> = (props) => {
  const { t } = useI18n();
  const presentation = useConversationPresentation();
  const canHandoff = presentation.identity.runtime === 'agent' && !presentation.readOnly
    && Boolean(presentation.snapshot && (!presentation.snapshot.thread.bot_id || presentation.snapshot.thread.parent_thread_id));
  const navigation = React.useContext(ReferenceNavigationContext);
  React.useEffect(() => {
    if (!navigation) return;
    navigation.revealEntry = props.onRevealEntry;
    return () => { if (navigation.revealEntry === props.onRevealEntry) delete navigation.revealEntry; };
  }, [navigation, props.onRevealEntry]);
  const root = React.useRef<HTMLDivElement>(null);
  const [sources] = React.useState(() => new Map<HTMLElement, ChatSourceData>());
  const [fileTargets] = React.useState(() => new Map<HTMLElement, ChatFileTarget>());
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState<MenuTarget | null>(null);
  const targetRef = React.useRef<MenuTarget | null>(null);
  const capturedEvent = React.useRef<Event | null>(null);
  const [memorySources, setMemorySources] = React.useState<ChatMemoryPassage[] | null>(null);
  const [imagePreview, setImagePreview] = React.useState<string | null>(null);
  const [handingOff, setHandingOff] = React.useState(false);
  const closeMemory = React.useCallback(() => setMemorySources(null), []);
  const context = React.useMemo(() => ({ sources, resolve: (source: ChatSourceData): ChatSourceData => {
    const entry = props.entries.find(entry => entry.id === source.entryId
      || entry.type === 'message' && entry.message.role === 'toolResult' && source.entryId === `tool-result:${entry.message.toolCallId}`);
    const content = entry?.type === 'message' && 'content' in entry.message ? entry.message.content : undefined;
    return { ...source, entryId: entry?.id ?? source.entryId, offset: chatTextSourceOffset(source, Array.isArray(content) ? content : undefined) };
  }, more: (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
  } }), [sources, props.entries]);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => { setOpen(false); setMemorySources(null); setImagePreview(null); setHandingOff(false); }), []);
  React.useEffect(() => {
    if (!open || !target?.selection || typeof Highlight === 'undefined' || !CSS.highlights) return;
    CSS.highlights.set('varin-chat-selection', new Highlight(target.selection));
    return () => { CSS.highlights.delete('varin-chat-selection'); };
  }, [open, target]);

  const capture = (node: EventTarget | null): MenuTarget | null => {
    const element = node instanceof Element ? node : null;
    const file = element?.closest<HTMLElement>('[data-varin-file-link="true"]');
    if (!element || !root.current?.contains(element)
      || element.closest('input,textarea,[contenteditable="true"],[data-interactive-ui],[data-conversation-ui-fragment]')
      || (element.closest('button') && !file && !element.closest('img, [data-chat-more], [data-md-image-src], [data-chat-quote-object]'))) return null;
    const runtimeKey = getRuntimeKey();
    const common = { runtimeKey, identity: { ...presentation.identity }, capturedAt: new Date().toISOString() };
    const resolved = new Map([...sources].map(([sourceElement, source]) => {
      const entry = props.entries.find(entry => entry.id === source.entryId
        || entry.type === 'message' && entry.message.role === 'toolResult' && source.entryId === `tool-result:${entry.message.toolCallId}`);
      const content = entry?.type === 'message' && 'content' in entry.message ? entry.message.content : undefined;
      return [sourceElement, { ...source, offset: chatTextSourceOffset(source, Array.isArray(content) ? content : undefined), entryId: entry?.id ?? source.entryId }] as const;
    }));
    const turnId = element.closest<HTMLElement>('[data-turn-id],[data-turn-entry]')?.getAttribute('data-turn-id')
      ?? element.closest<HTMLElement>('[data-turn-entry]')?.getAttribute('data-turn-entry');
    const row = props.projection.items.find(item => item.id === turnId);
    const item = row && resolveChatTimelineItem(row, props.projection.liveItem);
    const turnEntries = item?.kind === 'turn' ? item.turn.entries : item?.kind === 'entry' ? [item.entry] : [];
    const live = item?.kind === 'turn' ? item.turn.liveAssistant : item?.kind === 'live-assistant' ? item.message : undefined;
    const turn = captureAssistantTurn(turnEntries, live);

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0).cloneRange();
      if (root.current.contains(range.commonAncestorContainer)) {
        const captured = captureChatSelection(range, resolved, selection.toString());
        if (captured.text) {
          const roles = new Set(captured.passages.map(passage => props.entries.find(entry => entry.id === passage.entryId)).flatMap(entry =>
            entry?.type === 'message' ? [entry.message.role === 'toolResult' ? 'tool' : entry.message.role] : []));
          const role = roles.size === 1 ? [...roles][0] : undefined;
          const sourceRole = role === 'user' || role === 'assistant' || role === 'tool' ? role : undefined;
          return { kind: 'selection', ...captured, selection: range, sourceRole,
            title: sourceRole === 'user' ? t('chat.context.userSource') : sourceRole === 'assistant' ? 'Varin' : t('chat.context.quoteSelection'),
            sourceEntryId: captured.passages[0]?.entryId, ...common };
        }
      }
    }
    const image = element.closest<HTMLImageElement>('img');
    const imageLink = element.closest<HTMLElement>('[data-md-image-src],[data-md-image-link]');
    if ((image || imageLink) && file?.tagName !== 'BUTTON') {
      const imageElement = imageLink ?? image!;
      return { kind: 'image', text: '', href: image?.currentSrc || image?.src, element: imageElement,
        readImageOriginal: captureMarkdownImageReader(imageElement),
        reference: imageElement.closest('[data-attachment-ref],figure[data-chat-quote-object]') ? captureChatQuoteObject(imageElement) || undefined : undefined,
        sourceEntryId: imageElement.closest<HTMLElement>('[data-conversation-source-id]')?.dataset.conversationSourceId
          ?? imageElement.closest<HTMLElement>('[data-conversation-entry-id]')?.dataset.conversationEntryId, ...common };
    }
    if (file) {
      const path = file.getAttribute('data-varin-file-path') || file.textContent || '';
      const captured = fileTargets.get(file) ?? {
        path, directory: file.getAttribute('data-varin-file-directory') || undefined, runtimeKey,
        open: () => {
          if (!file.isConnected || file.getAttribute('data-varin-file-path') !== path) throw new Error(t('chat.context.sourceUnavailable'));
          file.click();
        },
      };
      return { kind: 'file', text: captured.path, element: file, ...common, file: captured };
    }
    const reference = captureChatQuoteObject(element);
    if (reference) return { kind: 'object', text: reference.text ?? '', reference, ...common };
    const references = captureChatQuoteGroup(element);
    if (references?.length) return { kind: 'group', text: '', references, ...common };
    const block = captureChatSourceBlock(element, resolved);
    const source = block?.source;
    const entry = props.entries.find((row): row is ChatSessionMessageEntry => row.id === source?.entryId && row.type === 'message');
    const body = block ? { text: block.text, passages: block.passages, sourceEntryId: source?.entryId, entry,
      sourceRole: source?.role === 'user' || entry?.message.role === 'user' ? 'user' as const : 'assistant' as const,
      title: source?.role === 'user' || entry?.message.role === 'user' ? t('chat.context.userSource') : 'Varin', streaming: source?.streaming, ...common } : undefined;
    const link = element.closest<HTMLAnchorElement>('a[href]');
    if (link) return { kind: 'link', text: '', ...body, href: link.href, element: link, ...common,
      turn: source?.role === 'assistant' && turn.text ? turn : undefined };
    if (body) return { ...body, kind: entry?.message.role === 'user' ? 'user' : block!.kind,
      turn: source?.role === 'assistant' && turn.text ? turn : undefined };
    // Chrome has no implicit body target. The only available quote expands the
    // explicitly named turn; a blank area must never guess the last message.
    return turn.text ? { kind: 'turn', text: '', turn, ...common } : null;
  };
  const freeze = (eventTarget: EventTarget | null) => {
    const captured = capture(eventTarget);
    targetRef.current = captured;
    setTarget(captured);
    return captured;
  };
  const perform = (action: (value: MenuTarget) => void | Promise<void>) => {
    const value = targetRef.current;
    if (!value || value.runtimeKey !== getRuntimeKey()) return;
    void Promise.resolve().then(() => {
      if (value.runtimeKey === getRuntimeKey()) return action(value);
    }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  };
  const copy = async (value: string) => {
    const result = await copyTextToClipboard(value);
    if (!result.ok) throw new Error(result.error);
  };
  const quote = (value: MenuTarget, wholeTurn = false) => {
    if (value.reference) return addChatObjectReference(value.identity, value.reference, presentation.api);
    const capture = wholeTurn ? value.turn : value;
    if (!capture?.text) return;
    const passages = capture.passages ?? [];
    const sourceEntryId = wholeTurn ? passages[0]?.entryId : value.sourceEntryId;
    const sourceLink = sourceEntryId ? `${SOURCE_LINK}${encodeURIComponent(props.sessionId)}:${encodeURIComponent(sourceEntryId)}` : '';
    addContentReference(value.identity, { ref: `chat-selection:${crypto.randomUUID()}`,
      title: wholeTurn ? 'Varin' : value.title ?? t('chat.context.source'), text: capture.text,
      source: { kind: 'chat', thread: value.identity, itemId: sourceEntryId, passages, href: sourceLink,
        capturedAt: value.capturedAt, streaming: capture.streaming, role: wholeTurn ? 'assistant' : value.sourceRole } });
  };
  const openTarget = (value: MenuTarget) => {
    const figure = value.element?.closest('[data-md-image-src]');
    if (value.kind === 'image' && figure) figure.querySelector<HTMLButtonElement>('.md-image-frame')?.click();
    else if(value.kind==='image'&&value.element?.closest('button'))value.element.closest('button')?.click();
    else if (value.kind === 'image' && value.href) setImagePreview(value.href);
    else if (value.element?.isConnected) value.element.click();
    else if (value.href && /^(https?:|data:image\/|blob:)/u.test(value.href)) window.open(value.href, '_blank', 'noopener,noreferrer');
    else throw new Error(t('chat.context.sourceUnavailable'));
  };
  const imageAction = async (value: MenuTarget, action: 'copy' | 'save' | 'quote') => {
    if (action === 'quote' && value.reference) return addChatObjectReference(value.identity, value.reference, presentation.api);
    const insertion = action === 'quote' ? beginContentReferenceInsertion(value.identity) : undefined;
    const controller = new AbortController();
    let original: Awaited<ReturnType<NonNullable<MenuTarget['readImageOriginal']>>> | undefined;
    try {
      original = value.readImageOriginal ? await value.readImageOriginal(controller.signal) : undefined;
      const src = original?.src ?? value.href;
      if (!src) throw new Error(t('chat.context.sourceUnavailable'));
      const response = await fetch(src);
      if (!response.ok) throw new Error(t('chat.context.failed'));
      const blob = await response.blob();
      if (value.runtimeKey !== getRuntimeKey()) return;
      if (action === 'quote') {
        const image = await fileToImageAttachment(new File([blob], 'reference', { type: blob.type }));
        if (value.runtimeKey !== getRuntimeKey()) return;
        insertion!.add({ ref: `chat-image:${crypto.randomUUID()}`, title: t('chat.context.openImage'), image,
          source: { kind: 'chat', thread: value.identity, itemId: value.sourceEntryId, passages: [], capturedAt: value.capturedAt } });
      } else if (action === 'save') {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = `image.${blob.type.split('/')[1] || 'png'}`;
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      } else {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
        const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('chat.context.failed'))), 'image/png'));
        if (value.runtimeKey !== getRuntimeKey()) return;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }
    } finally { original?.release?.(); insertion?.dispose(); }
  };
  return <ChatActionsContext.Provider value={context}><ChatFileTargetsContext.Provider value={fileTargets}>
    <ContextMenu open={open} onOpenChange={(next, details) => {
      if (next && capturedEvent.current !== details.event && !freeze(details.event.target)) { details.cancel(); return; }
      setOpen(next);

    }}>
      <ContextMenuTrigger asChild>
        <div ref={root} className="flex min-h-0 flex-1"
          onContextMenuCapture={(event) => {
            if (event.target instanceof Element && event.target.closest('[data-interactive-ui],[data-conversation-ui-fragment]')) return;
            capturedEvent.current = event.nativeEvent;
            if (!freeze(event.target)) event.stopPropagation();
          }}
          onClickCapture={(event) => {
            const href = (event.target as Element).closest('a')?.getAttribute('href');
            if (!href?.startsWith(SOURCE_LINK)) return;
            event.preventDefault(); event.stopPropagation();
            try {
              const [session, entry] = href.slice(SOURCE_LINK.length).split(':').map(decodeURIComponent);
              if (session !== props.sessionId || !entry) throw new Error(t('chat.context.sourceUnavailable'));
              void Promise.resolve(props.onRevealEntry(entry)).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
            } catch { toast.error(t('chat.context.sourceUnavailable')); }
          }}>
          {props.children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {target?.kind === 'group' ? target.references?.map((reference, index) => <ContextMenuItem key={reference.ref}
          onClick={() => perform(value => { if (value.references?.[index]) return addChatObjectReference(value.identity, value.references[index]!, presentation.api); })}>
          {t('chat.context.quoteTool')} · {index + 1}. {reference.title}
        </ContextMenuItem>) : target?.kind === 'image' ? <>
          <ContextMenuItem onClick={() => perform(value => imageAction(value, 'quote'))}>{t('chat.context.quoteImage')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform(openTarget)}>{t('chat.context.openImage')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform((value) => imageAction(value, 'copy'))}>{t('chat.context.copyImage')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform((value) => imageAction(value, 'save'))}>{t('chat.context.saveImage')}</ContextMenuItem>
        </> : target?.kind === 'file' && target.file ? <ChatFileMenu target={target.file} /> : target?.kind === 'link' ? <>
          <ContextMenuItem onClick={() => perform(openTarget)}>{t('chat.context.openLink')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform((value) => copy(value.href ?? ''))}>{t('chat.context.copyLink')}</ContextMenuItem>
          {target.text && <ContextMenuItem onClick={() => perform(value => quote(value))}>{t('chat.context.quoteBlock')}</ContextMenuItem>}
          {target.turn && <ContextMenuItem onClick={() => perform(value => quote(value, true))}>{t('chat.context.quoteTurn')}</ContextMenuItem>}
        </> : target ? <>
          {target.text && <ContextMenuItem onClick={() => perform((value) => copy(value.copyText ?? value.text))}>{t(target.kind === 'code' ? 'chat.context.copyCode' : 'chat.context.copy')}</ContextMenuItem>}
          {(target.text || target.reference) && <ContextMenuItem onClick={() => perform(value => quote(value))}>{t(target.kind === 'selection' ? 'chat.context.quoteSelection' : target.kind === 'code' ? 'chat.context.quoteCode' : target.kind === 'object' ? target.reference?.source.kind === 'tool' ? 'chat.context.quoteTool' : 'chat.context.quoteFile' : 'chat.context.quoteBlock')}</ContextMenuItem>}
          {target.turn && <><ContextMenuItem onClick={() => perform(value => quote(value, true))}>{t('chat.context.quoteTurn')}</ContextMenuItem>
            <ContextMenuItem onClick={() => perform(value => copy(value.turn!.text))}>{t('chat.context.copyTurn')}</ContextMenuItem></>}
          {canHandoff && <ContextMenuItem onClick={() => setHandingOff(true)}>{t('bot.handoff.title')}</ContextMenuItem>}
          {target.kind === 'selection' && presentation.memory && presentation.head ? <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!presentation.memory || !presentation.head || !target.complete} title={target.complete ? undefined : t('chat.context.sourceUnavailable')}
              onClick={() => perform((value) => setMemorySources(value.passages!))}>{t('chat.context.extract')}</ContextMenuItem>
          </> : target.entry && (props.onFork || props.onOpenThread || (target.kind === 'user' && props.onRecover)) ? <>
            <ContextMenuSeparator />
            {props.onOpenThread ? <ContextMenuItem disabled={!!props.threadBusyEntryId}
              onClick={() => perform((value) => props.onOpenThread!(value.entry!, { carryBlocks: true }))}>{t('chat.messageBody.actions.openThread')}</ContextMenuItem> : null}
            {props.onFork ? <ContextMenuItem disabled={!!props.forkBusyEntryId}
              onClick={() => perform((value) => props.onFork!(value.entry!))}>{t('chat.messageBody.actions.fork')}</ContextMenuItem> : null}
            {target.kind === 'user' && props.onRecover ? <ContextMenuItem disabled={!!props.recoveryBusyEntryId}
              onClick={() => perform((value) => props.onRecover!(value.entry!))}>{t('chat.messageBody.actions.revert')}</ContextMenuItem> : null}
          </> : null}
        </> : null}
      </ContextMenuContent>
    </ContextMenu>
    {memorySources ? <ChatMemoryDialog sessionId={props.sessionId} sources={memorySources} onClose={closeMemory} /> : null}
    {handingOff && canHandoff && <React.Suspense fallback={null}><BotHandoffDialog identity={presentation.identity} onClose={() => setHandingOff(false)} /></React.Suspense>}
    {imagePreview ? <ConversationImageViewer src={imagePreview} onClose={()=>setImagePreview(null)} /> : null}
  </ChatFileTargetsContext.Provider></ChatActionsContext.Provider>;
};
