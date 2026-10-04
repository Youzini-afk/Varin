import React from 'react';
import type { PiSessionMessageEntry } from '@varin/protocol';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, type ChatMemoryPassage } from '@varin/application-client';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { readPiDraft, usePiDraftStore } from '@/stores/usePiDraftStore';
import { getMarkdownCodeText } from '@/components/chat/markdown/decorate';
import { captureChatSelection, type ChatTextSource as ChatSourceData } from './chatSelection';
import { ChatMemoryDialog } from './ChatMemoryDialog';
import { resolvePiTimelineItem, type PiTimelineProjection } from './piTimelineProjection';
import type { PiTimelineProps } from './PiTimelineEntries';
import { assistantMessagesForTurn } from '@/lib/pi-runtime/usagePresentation';
import { piContentText } from './extensionPresentation';

const SOURCE_LINK = '#varin-chat-source:';
export const CHAT_QUOTE_EVENT = 'varin:chat-quote';

const ChatActionsContext = React.createContext<{
  sources: Map<HTMLElement, ChatSourceData>;
  more(element: HTMLElement): void;
} | null>(null);

export const ChatTextSource: React.FC<ChatSourceData & { children: React.ReactNode }> = ({ children, entryId, text, offset, contentIndex }) => {
  const context = React.useContext(ChatActionsContext);
  const previous = React.useRef<HTMLDivElement | null>(null);
  const attach = React.useCallback((element: HTMLDivElement | null) => {
    if (previous.current) context?.sources.delete(previous.current);
    previous.current = element;
    if (element) context?.sources.set(element, { entryId, text, offset, contentIndex });
  }, [contentIndex, context, entryId, offset, text]);
  return <div ref={attach} className="contents" data-pi-chat-source data-pi-source-id={entryId}>{children}</div>;
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
  kind: 'selection' | 'user' | 'turn' | 'code' | 'link' | 'file' | 'image';
  text: string;
  entry?: PiSessionMessageEntry;
  sourceEntryId?: string;
  href?: string;
  element?: HTMLElement;
  selection?: Range;
  passages?: ChatMemoryPassage[];
  complete?: boolean;
  runtimeKey: string;
}

export const ChatContextMenu: React.FC<Pick<PiTimelineProps,
  'sessionId' | 'entries' | 'onFork' | 'onOpenThread' | 'onRecover' | 'forkBusyEntryId' | 'threadBusyEntryId' | 'recoveryBusyEntryId'
> & { projection: PiTimelineProjection; children: React.ReactNode; onRevealEntry(entryId: string): void | Promise<void> }> = (props) => {
  const { t } = useI18n();
  const root = React.useRef<HTMLDivElement>(null);
  const [sources] = React.useState(() => new Map<HTMLElement, ChatSourceData>());
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState<MenuTarget | null>(null);
  const targetRef = React.useRef<MenuTarget | null>(null);
  const [memorySources, setMemorySources] = React.useState<ChatMemoryPassage[] | null>(null);
  const [imagePreview, setImagePreview] = React.useState<string | null>(null);
  const closeMemory = React.useCallback(() => setMemorySources(null), []);
  const context = React.useMemo(() => ({ sources, more: (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
  } }), [sources]);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => { setOpen(false); setMemorySources(null); setImagePreview(null); }), []);
  React.useEffect(() => {
    if (!open || !target?.selection || typeof Highlight === 'undefined' || !CSS.highlights) return;
    CSS.highlights.set('varin-chat-selection', new Highlight(target.selection));
    return () => { CSS.highlights.delete('varin-chat-selection'); };
  }, [open, target]);

  const capture = (node: EventTarget | null): MenuTarget | null => {
    const element = node instanceof Element ? node : null;
    if (!element || !root.current?.contains(element)
      || element.closest('input,textarea,[contenteditable="true"]')
      || (element.closest('button') && !element.closest('[data-chat-more]'))) return null;
    const runtimeKey = getRuntimeKey();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0).cloneRange();
      if (root.current.contains(range.commonAncestorContainer)) {
        const resolved = new Map([...sources].map(([sourceElement, source]) => {
          const entry = props.entries.find((entry) => entry.id === source.entryId
            || (entry.type === 'message' && entry.message.role === 'toolResult'
              && source.entryId === `tool-result:${entry.message.toolCallId}`));
          const content = entry?.type === 'message' && 'content' in entry.message ? entry.message.content : undefined;
          const offset = source.contentIndex !== undefined && Array.isArray(content)
            ? content.slice(0, source.contentIndex).filter((part) => part.type === 'text').reduce((total, part) => total + part.text.length + 1, 0)
            : source.offset;
          return [sourceElement, { ...source, offset, entryId: entry?.id }] as const;
        }));
        const captured = captureChatSelection(range, resolved, selection.toString());
        if (captured.text) return { kind: 'selection', ...captured, selection: range,
          sourceEntryId: captured.passages[0]?.entryId, runtimeKey };
      }
    }
    const image = element.closest<HTMLImageElement>('img');
    if (image) return { kind: 'image', text: '', href: image.currentSrc || image.src, element: image.closest('a') ?? image, runtimeKey };
    const file = element.closest<HTMLElement>('[data-varin-file-link="true"]');
    if (file) return { kind: 'file', text: file.getAttribute('data-varin-file-path') || file.textContent || '', element: file, runtimeKey };
    const link = element.closest<HTMLAnchorElement>('a[href]');
    if (link) return { kind: 'link', text: link.getAttribute('href') || '', href: link.href, element: link, runtimeKey };
    const source = [...sources].find(([sourceElement]) => sourceElement.contains(element))?.[1];
    const code = element.closest('[data-component="markdown-code"],pre')?.querySelector<HTMLElement>('code');
    if (code) return { kind: 'code', text: getMarkdownCodeText(code), sourceEntryId: source?.entryId, runtimeKey };
    const entryId = element.closest<HTMLElement>('[data-pi-entry-id]')?.dataset.piEntryId;
    const entry = props.entries.find((row): row is PiSessionMessageEntry => row.id === entryId && row.type === 'message');
    if (entry?.message.role === 'user') return { kind: 'user', text: piContentText(entry.message.content), entry, sourceEntryId: entry.id, runtimeKey };
    const pendingUser = element.closest('[data-pi-user-message]');
    if (pendingUser) return { kind: 'user', text: [...sources].filter(([sourceElement]) => pendingUser.contains(sourceElement))
      .map(([, source]) => source.text).join('\n'), runtimeKey };
    const turnId = element.closest<HTMLElement>('[data-turn-id],[data-turn-entry]')?.getAttribute('data-turn-id')
      ?? element.closest<HTMLElement>('[data-turn-entry]')?.getAttribute('data-turn-entry');
    const row = props.projection.items.find((item) => item.id === turnId);
    if (!row) return null;
    const item = resolvePiTimelineItem(row, props.projection.liveItem);
    if (!item) return null;
    const entries = item.kind === 'turn' ? item.turn.entries : item.kind === 'entry' ? [item.entry] : [];
    const live = item.kind === 'turn' ? item.turn.liveAssistant : item.kind === 'live-assistant' ? item.message : undefined;
    const replies = assistantMessagesForTurn(entries, live);
    const text = replies.map((message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim()).filter(Boolean).join('\n\n');
    const last = entries.filter((row): row is PiSessionMessageEntry => row.type === 'message' && row.message.role === 'assistant'
      && row.message.content.some((part) => part.type === 'text' && part.text.trim())).at(-1);
    return text ? { kind: 'turn', text, entry: last, sourceEntryId: last?.id, runtimeKey } : null;
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
  const quote = (value: MenuTarget) => {
    const sourceLink = value.sourceEntryId
      ? `[${t('chat.context.source')}](${SOURCE_LINK}${encodeURIComponent(props.sessionId)}:${encodeURIComponent(value.sourceEntryId)})\n\n`
      : '';
    const text = [readPiDraft(props.sessionId).text.trimEnd(), sourceLink + value.text.split('\n').map((line) => `> ${line}`).join('\n')]
      .filter(Boolean).join('\n\n') + '\n\n';
    usePiDraftStore.getState().setDraft(props.sessionId, { text }, value.runtimeKey);
    window.dispatchEvent(new CustomEvent(CHAT_QUOTE_EVENT, { detail: {
      sessionId: props.sessionId, runtimeKey: value.runtimeKey, cursor: text.length,
    } }));
  };
  const openTarget = (value: MenuTarget) => {
    if (value.kind === 'image' && value.href) setImagePreview(value.href);
    else if (value.element?.isConnected) value.element.click();
    else if (value.href && /^(https?:|data:image\/|blob:)/u.test(value.href)) window.open(value.href, '_blank', 'noopener,noreferrer');
    else throw new Error(t('chat.context.sourceUnavailable'));
  };
  const imageAction = async (value: MenuTarget, action: 'copy' | 'save') => {
    const response = await fetch(value.href!);
    if (!response.ok) throw new Error(t('chat.context.failed'));
    const blob = await response.blob();
    if (action === 'save') {
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
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    }
  };
  return <ChatActionsContext.Provider value={context}>
    <ContextMenu open={open} onOpenChange={(next, details) => {
      if (next && !freeze(details.event.target)) { details.cancel(); return; }
      setOpen(next);
    }}>
      <ContextMenuTrigger asChild>
        <div ref={root} className="flex min-h-0 flex-1"
          onContextMenuCapture={(event) => { if (!freeze(event.target)) event.stopPropagation(); }}
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
        {target?.kind === 'image' ? <>
          <ContextMenuItem onClick={() => perform(openTarget)}>{t('chat.context.openImage')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform((value) => imageAction(value, 'copy'))}>{t('chat.context.copyImage')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform((value) => imageAction(value, 'save'))}>{t('chat.context.saveImage')}</ContextMenuItem>
        </> : target?.kind === 'link' || target?.kind === 'file' ? <>
          <ContextMenuItem onClick={() => perform(openTarget)}>{t(target.kind === 'file' ? 'chat.context.openFile' : 'chat.context.openLink')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform((value) => copy(value.text))}>{t(target.kind === 'file' ? 'chat.context.copyPath' : 'chat.context.copyLink')}</ContextMenuItem>
        </> : target ? <>
          <ContextMenuItem onClick={() => perform((value) => copy(value.text))}>{t(target.kind === 'turn' ? 'chat.context.copyTurn' : target.kind === 'code' ? 'chat.context.copyCode' : 'chat.context.copy')}</ContextMenuItem>
          <ContextMenuItem onClick={() => perform(quote)}>{t('chat.context.quote')}</ContextMenuItem>
          {target.kind === 'selection' ? <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!target.complete} title={target.complete ? undefined : t('chat.context.sourceUnavailable')}
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
    {imagePreview ? <Dialog open onOpenChange={(open) => { if (!open) setImagePreview(null); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader><DialogTitle>{t('chat.context.openImage')}</DialogTitle></DialogHeader>
        <img src={imagePreview} alt={t('chat.context.openImage')} className="max-h-[75dvh] w-full object-contain" />
      </DialogContent>
    </Dialog> : null}
  </ChatActionsContext.Provider>;
};
