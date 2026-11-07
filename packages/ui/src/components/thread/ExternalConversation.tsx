import { externalFollowupState } from '@/lib/followupPresentation';
import { draftImageReferences } from '@/lib/images/references';
import { externalAttachmentSupported } from './externalAttachments';
import React from 'react';
import { ComposerActionForm } from './ComposerActionForm';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import {
  createExternalAgentsHttpAPI,
  ExternalAgentError,
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointChanged,
  type ExternalConversationSnapshot,
  type ExternalItem,
  type ExternalTurn,
  type ExternalObservation,
} from '@varin/application-client';
import { useExternalAgents, useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { ThreadComposer } from './ThreadComposer';
import { HarnessSelector } from './HarnessSelector';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ChatThinkingBlock } from '@/components/conversation/ChatThinkingBlock';
import { ToolDisclosure, ToolDisclosureScope, ToolStatus } from '@/components/conversation/ToolDisclosure';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { prepareAnnotatedImages } from '@/lib/images/annotations';
import { ConversationImageViewer } from '@/components/images/ConversationImage';
import { ImageReplyDraftContext } from '@/components/images/useImageReply';
import {
  removeDraftImage,
} from '@/components/chat/composer/imageAttachments';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConversationScrollbar } from '@/components/conversation/ConversationScrollbar';
import { ExternalOverview } from './ExternalOverview';
import { ChatFileChangePreview } from '@/components/conversation/ChatFileChangePreview';
import type { FileChangePreview } from '@/components/conversation/fileChangePreview';
import { PartialJson } from '@/lib/interactive-ui/partial-json';
import { openFileInMainEditor } from '@/lib/openFileInMainEditor';
import { toast } from '@/components/ui';
import { ChatAgentMessageBubble } from '@/components/conversation/ChatAgentMessageBubble';
import { ExternalInteractionForm } from './ExternalInteractionForm';
import { ExternalConnectionStatus } from './ExternalConnectionStatus';
import { externalSessionInput, normalizeExternalSessionChoice } from './externalSessionChoice';
import { removeDraftFile, attachmentImageReferences, selectThreadFiles, prepareDraftFiles } from '@/lib/agent-runtime/fileAttachments';
import { ThreadAttachments, ThreadFileDrafts } from './ThreadAttachments';

const describe = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
const heading = (item: ExternalItem) => {
  if (!item.tool) return item.text.split('\n').find((v) => v.trim()) ?? '';
  const input =
    item.tool.input && typeof item.tool.input === 'object'
      ? (item.tool.input as Record<string, unknown>)
      : {};
  return [
    item.tool.name,
    item.tool.command ?? input.command ?? item.tool.path ?? input.file_path ?? input.path ?? input.pattern,
  ]
    .filter(Boolean)
    .join(' · ');
};
const Item = React.memo(function Item({
  item,
  active,
  expanded = false,
  cwd,
  readAttachment,
}: {
  readAttachment(ref: string, signal: AbortSignal): Promise<Blob>;
  item: ExternalItem;
  active: boolean;
  expanded?: boolean;
  cwd: string;
}) {
  const { t } = useI18n();
  const [image, setImage] = React.useState<{src:string;index:number}>();
  const json = React.useRef({ raw: '', reader: new PartialJson() });
  let input = item.tool?.input;
  if (typeof input === 'string' && input.trimStart().startsWith('{')) {
    if (!input.startsWith(json.current.raw)) json.current = { raw: '', reader: new PartialJson() };
    json.current.reader.feed(input.slice(json.current.raw.length));
    json.current.raw = input;
    input = json.current.reader.value;
  }
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const filePath = args.file_path ?? args.path,
    content = args.content ?? args.text;
  const file = React.useMemo<FileChangePreview | undefined>(() => {
    if (
      !['Write', 'write', 'write_file', 'file_write'].includes(item.tool?.name ?? '') ||
      typeof filePath !== 'string' ||
      typeof content !== 'string'
    )
      return;
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return {
      path: filePath,
      operation: 'write',
      lines: lines.map((text, index) => ({
        kind: 'add',
        text,
        key: `w${index}`,
        pending: item.tool?.status === 'running' && index === lines.length - 1,
      })),
    };
  }, [item.tool?.name, item.tool?.status, filePath, content]);
  if (item.kind === 'reasoning')
    return (
      <ChatThinkingBlock
        content={{ type: 'thinking', thinking: item.text }}
        messageId={item.id}
        streaming={active && !item.complete}
        label={t('chat.context.thinking')}
      />
    );
  if (item.senderThreadId)
    return (
      <ChatAgentMessageBubble
        id={item.id}
        kind={item.kind === 'notice' ? 'message' : 'task'}
        senderThreadId={item.senderThreadId}
        text={item.text}
        attachments={<ThreadAttachments attachments={item.attachments} read={readAttachment} />}
      >
        <MarkdownRenderer content={item.text} messageId={item.id} variant="assistant" />
      </ChatAgentMessageBubble>
    );
  if (file)
    return (
      <ChatFileChangePreview
        previewId={item.id}
        file={file}
        phase={
          item.tool?.status === 'failed'
            ? 'failed'
            : item.tool?.status === 'completed'
              ? 'applied'
              : typeof item.tool?.input === 'string'
                ? 'generating'
                : 'applying'
        }
        onOpen={() => {
          const path = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(file.path) ? file.path : `${cwd}/${file.path}`;
          if (!openFileInMainEditor(cwd, path)) toast.error(t('external.fileUnavailable'));
        }}
      />
    );
  if (item.kind === 'tool' && item.tool)
    return (
      <ToolDisclosure id={`tool:${item.id}`} initiallyExpanded={expanded} className="my-2">
        <summary className="flex min-w-0 cursor-pointer items-center gap-2 py-2 typography-meta text-muted-foreground">
          <Icon name={item.tool.command ? 'terminal' : 'code-box'} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{heading(item)}</span>
          <ToolStatus
            status={
              item.tool.status === 'completed'
                ? 'success'
                : item.tool.status === 'failed'
                  ? 'error'
                  : 'running'
            }
          />
          <Icon name="arrow-right-s" className="size-3" />
        </summary>
        <div className="space-y-3 border-l border-border/60 pl-4">
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all typography-meta text-muted-foreground">
            {describe(item.tool.input)}
          </pre>
          {item.tool.output !== undefined && (
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all typography-meta">
              {describe(item.tool.output)}
            </pre>
          )}
        </div>
      </ToolDisclosure>
    );
  return (
    <div
      className={item.kind === 'user' ? 'ml-auto w-fit max-w-full rounded-2xl bg-muted px-4 py-3' : 'py-2'}
    >
      {item.images?.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {item.images.map((value, index) => (
            <button
              key={index}
              type="button"
              className="relative overflow-hidden rounded-lg border border-border"
              onClick={() => setImage({src:`data:${value.mimeType};base64,${value.data}`,index})}
              aria-label={t('chat.imageReference.token', { number: index + 1 })}
            >
              <img
                src={`data:${value.mimeType};base64,${value.data}`}
                className="size-24 object-cover"
                alt={t('chat.imageReference.token', { number: index + 1 })}
              />
              <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 typography-micro text-muted-foreground">
                {index + 1}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <MarkdownRenderer
        content={item.text}
        messageId={item.id}
        isStreaming={active && !item.complete && item.kind === 'assistant'}
        variant={item.kind === 'notice' ? 'tool' : 'assistant'}
      />
      <ThreadAttachments attachments={item.attachments} read={readAttachment} />
      {image&&<ConversationImageViewer src={image.src} sourceId={`${item.id}:image:${image.index}`} label={t('chat.imageReference.token',{number:image.index+1})} onClose={()=>setImage(undefined)}/>}
    </div>
  );
});
function TurnFooter({ turn, answer }: { turn: ExternalTurn; answer?: string }) {
  const { t } = useI18n();
  const usage = turn.usage;
  const input = usage?.input,
    cached = usage?.cachedInput ?? 0,
    created = usage?.cacheCreated ?? 0;
  const denominator =
    input === undefined || usage?.inputIncludesCache === undefined
      ? undefined
      : input + (usage.inputIncludesCache ? 0 : cached + created);
  const rate =
    cached > 0 && denominator && cached <= denominator
      ? `${((cached / denominator) * 100).toFixed(1)}%`
      : undefined;
  return (
    <div className="mb-6 mt-3 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 typography-micro text-muted-foreground">
      <div className="flex items-center gap-2">
        {answer && (
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded hover:bg-interactive-hover hover:text-foreground"
            aria-label={t('chat.messageBody.actions.copyMessageAria')}
            onClick={() =>
              void navigator.clipboard.writeText(answer).catch((error) => toast.error(String(error)))
            }
          >
            <Icon name="file-copy" className="size-3.5" />
          </button>
        )}
        <span>{t(`external.status.${turn.status}`)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 tabular-nums">
        {usage?.scope === 'conversation' && <span>{t('external.conversationUsage')}</span>}
        {usage?.scope === 'last_request' && <span>{t('external.lastRequest')}</span>}
        {input !== undefined && <span>↓ {input.toLocaleString()}</span>}
        {usage?.output !== undefined && <span>↑ {usage.output.toLocaleString()}</span>}
        {cached > 0 && (
          <span>
            {t('external.cached')} {cached.toLocaleString()}
          </span>
        )}
        {created > 0 && (
          <span>
            {t('external.cacheCreated')} {created.toLocaleString()}
          </span>
        )}
        {rate && (
          <span>
            {t('external.cacheRate')} {rate}
          </span>
        )}
      </div>
    </div>
  );
}
function Messages({
  items,
  activeTurn,
  cwd,
  receipts,
  readAttachment,
}: {
  readAttachment(ref: string, signal: AbortSignal): Promise<Blob>;
  items: ExternalItem[];
  activeTurn?: string;
  cwd: string;
  receipts: ExternalTurn[];
}) {
  const mode = useUIStore((state) => state.chatRenderMode);
  const groups: ExternalItem[][] = [];
  const turns = new Map<string, ExternalItem[]>();
  for (const item of items) {
    const entries = turns.get(item.turnId) ?? [];
    entries.push(item);
    turns.set(item.turnId, entries);
  }
  const ordered =
    mode === 'sorted'
      ? [...turns.values()].flatMap((turn) => [
          ...turn.filter((i) => i.kind === 'user'),
          ...turn.filter((i) => ['tool', 'reasoning', 'plan', 'notice'].includes(i.kind)),
          ...turn.filter((i) => i.kind === 'assistant'),
        ])
      : items;
  for (const item of ordered) {
    const activity = item.kind === 'tool' || item.kind === 'reasoning';
    const last = groups.at(-1);
    if (
      mode !== 'live' &&
      activity &&
      last?.every((v) => v.kind === 'tool' || v.kind === 'reasoning') &&
      last[0]?.turnId === item.turnId
    )
      last.push(item);
    else groups.push([item]);
  }
  return (
    <>
      {groups.map((group, index) => {
        const receipt = receipts.find((turn) => turn.id === group[0]!.turnId);
        const ended =
          receipt &&
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(receipt.status) &&
          groups[index + 1]?.[0]?.turnId !== receipt.id;
        return (
          <React.Fragment key={group[0]!.id}>
            {group.length === 1 ? (
              <Item readAttachment={readAttachment}
                item={group[0]!}
                cwd={cwd}
                active={group[0]!.turnId === activeTurn}
                expanded={mode === 'live'}
              />
            ) : (
              <ToolDisclosure id={`external-activity:${group[0]!.id}`}>
                <summary className="flex cursor-pointer items-center gap-2 py-2 typography-meta text-muted-foreground">
                  <Icon name="arrow-right-s" className="size-3" />
                  <span className="min-w-0 truncate">{heading(group.at(-1)!)}</span>
                  <span className="tabular-nums">{group.length}</span>
                </summary>
                <div className="border-l border-border/50 pl-4">
                  {group.map((item) => (
                    <Item readAttachment={readAttachment} key={item.id} item={item} cwd={cwd} active={item.turnId === activeTurn} />
                  ))}
                </div>
              </ToolDisclosure>
            )}
            {ended && (
              <>
                <TurnFooter
                  turn={receipt}
                  answer={
                    turns
                      .get(receipt.id)
                      ?.filter((item) => item.kind === 'assistant')
                      .at(-1)?.text
                  }
                />
                {receipt.error && (
                  <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
                    {receipt.error}
                  </p>
                )}
              </>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
export function ExternalConversationView({ id, readOnly = false, turnId }: { id: string; readOnly?: boolean; turnId?: string }) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ExternalConversationSession key={`${host}:${id}:${turnId ?? ''}`} id={id} host={host} readOnly={readOnly || !!turnId} turnId={turnId} />;
}
function ExternalConversationSession({ id, host, readOnly, turnId }: { id: string; host: number; readOnly: boolean; turnId?: string }) {
  const { t } = useI18n();
  const snapshotPublisher = React.useRef({}).current;
  const api = React.useMemo(() => createExternalAgentsHttpAPI(host), [host]);
  const settings = useExternalAgents();
  const [snapshot, setSnapshot] = React.useState<ExternalConversationSnapshot>();
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>();
  const [connecting, setConnecting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const cancellation = React.useRef<Promise<void> | undefined>(undefined);
  const connectionVersion = React.useRef(0);
  const connection = React.useRef<{ cancelled: boolean; promise: Promise<ExternalConversationSnapshot | undefined> } | undefined>(undefined);
  const [terminating, setTerminating] = React.useState(false);
  const acting = React.useRef(false);
  const terminatingRef = React.useRef(false);
  const refreshView = React.useRef<() => Promise<void>>(async () => {});
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => mounted.current && host === getRuntimeEndpointGeneration();
  React.useEffect(() => { if (snapshot) useExternalAgentStore.getState().setSnapshot(snapshot, host, snapshotPublisher); }, [snapshot, host, snapshotPublisher]);
  React.useEffect(() => () => useExternalAgentStore.getState().clearSnapshot(id, host, snapshotPublisher), [id, host, snapshotPublisher]);
  const ensureConnected = (force: boolean | 'models' = false): Promise<ExternalConversationSnapshot | undefined> => {
    if (connection.current) return connection.current.promise;
    if (force === true && snapshot?.connected && snapshot.capabilities?.resume === false) return Promise.reject(new ExternalAgentError('resume_unsupported', t('external.reconnectUnsupported')));
    if (!force && snapshot?.connected && snapshot.capabilitiesSource !== 'cached') return Promise.resolve(snapshot);
    if (!isCurrent() || readOnly || force === true && snapshot?.turns.some(turn => ['queued', 'preparing', 'running', 'waiting_user', 'stopping'].includes(turn.status))) return Promise.resolve(undefined);
    const token = { cancelled: false, promise: Promise.resolve(undefined) as Promise<ExternalConversationSnapshot | undefined> };
    connection.current = token; connectionVersion.current++; setConnecting(true); setFailure(undefined);
    token.promise = (async () => {
      if (force === true) await api.disconnect(id);
      if (!isCurrent() || token.cancelled) return;
      await api.connect(id);
      if (!isCurrent() || token.cancelled) return;
      const value = await api.read(id);
      if (!isCurrent() || token.cancelled) return;
      setSnapshot(value); return value;
    })().catch(error => { if (isCurrent() && !token.cancelled) { setFailure(error); throw error; } return undefined; }).finally(() => {
      if (connection.current === token) { connection.current = undefined; connectionVersion.current++; if (isCurrent()) setConnecting(false); }
    });
    return token.promise;
  };
  const cancelConnection = (): Promise<void> => {
    if (cancellation.current) return cancellation.current;
    if (!isCurrent()) return Promise.resolve();
    setCancelling(true); const token = connection.current; if (token) token.cancelled = true;
    connectionVersion.current++;
    const work = (async () => {
      try {
        await api.disconnect(id);
        if (!isCurrent()) return;
        if (connection.current === token) connection.current = undefined;
        setConnecting(false); setFailure(undefined); await refreshView.current();
      } catch (error) { if (isCurrent()) setFailure(error); }
      finally { cancellation.current = undefined; connectionVersion.current++; if (isCurrent()) setCancelling(false); }
    })();
    cancellation.current = work; return work;
  };
  const [details, setDetails] = React.useState(false);
  const [earlier, setEarlier] = React.useState<ExternalItem[]>([]);
  const [previous, setPrevious] = React.useState<number | null>();
  const editor = React.useRef<ComposerEditorHandle | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const viewport = React.useRef<HTMLDivElement>(null);
  const follow = React.useRef(true);
  const prepend = React.useRef<{ height: number; top: number } | null>(null);
  const track = React.useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLDivElement | null>(null);
  const bindViewport = React.useCallback((element: HTMLDivElement | null) => {
    viewport.current = element;
    setScrollElement(element);
  }, []);
  const key = `external-draft:${host}:${id}`;
  const draft = useThreadDraftStore((state) => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const patch = (value: Parameters<ReturnType<typeof useThreadDraftStore.getState>['patch']>[1]) =>
    useThreadDraftStore.getState().patch(key, value);
  React.useEffect(() => {
    const controller = new AbortController();
    let refreshing = false,
      dirty = false;
    let frame = 0;
    let current: ExternalConversationSnapshot | undefined;
    let events: ExternalObservation[] = [];
    const render = () => {
      frame = 0;
      if (!current || refreshing || controller.signal.aborted) return;
      const items = new Map(current.items.map((item) => [item.id, item]));
      for (const event of events) {
        if (event.epoch !== current.observationEpoch || event.revision <= current.observationRevision)
          continue;
        if (event.kind === 'item') items.set(event.item.id, event.item);
        else if (event.kind === 'text_delta' || event.kind === 'tool_delta') {
          const old = items.get(event.id);
          if (!old || old.turnId !== event.turnId) {
            void refresh();
            return;
          }
          if (event.kind === 'text_delta')
            items.set(event.id, {
              ...old,
              text: old.text + event.text,
              ...(event.complete === undefined ? {} : { complete: event.complete }),
            });
          else if (old.tool)
            items.set(event.id, {
              ...old,
              tool: { ...old.tool, [event.field]: String(old.tool[event.field] ?? '') + event.text },
            });
        }
        current = { ...current, observationRevision: event.revision };
      }
      events = [];
      current = { ...current, items: [...items.values()] };
      setSnapshot(current);
    };
    const refresh = async () => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (dirty && !controller.signal.aborted) {
          dirty = false;
          const version = connectionVersion.current;
          const value = await api.read(id, undefined, controller.signal);
          if (version !== connectionVersion.current) { dirty = true; continue; }
          if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) {
            current = value;
            setSnapshot(value);
            setPrevious((old) => (old === undefined ? (value.previous ?? null) : old));
            setError('');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(String(error));
      } finally {
        refreshing = false;
        if (events.length && current && !controller.signal.aborted && !frame)
          frame = requestAnimationFrame(render);
      }
    };
    refreshView.current = refresh;
    void refresh();
    void api
      .observe(
        id,
        (event) => {
          if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
          if (event.kind === 'unavailable') {
            setError(event.message);
            return;
          }
          if (event.kind === 'refresh' || (current && event.epoch !== current.observationEpoch)) {
            void refresh();
            return;
          }
          events.push(event);
          if (!frame) frame = requestAnimationFrame(render);
        },
        controller.signal,
      )
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error));
      });
    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
      refreshView.current = async () => {};
    };
  }, [api, id, host]);
  React.useEffect(() => {
    if (!turnId || !snapshot || !previous || earlier.some(item => item.turnId === turnId) || snapshot.items.some(item => item.turnId === turnId)
      || snapshot.turns.at(-1)?.id === turnId) return;
    const controller = new AbortController();
    void api.read(id, previous, controller.signal).then(page => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setEarlier(old => [...page.items, ...old]);
      setPrevious(page.previous === previous ? null : page.previous ?? null);
    }, cause => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [api, id, host, turnId, snapshot, earlier, previous]);
  React.useLayoutEffect(() => {
    if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [snapshot]);
  React.useLayoutEffect(() => {
    const saved = prepend.current,
      node = viewport.current;
    if (saved && node) {
      node.scrollTop = saved.top + node.scrollHeight - saved.height;
      prepend.current = null;
    }
  }, [earlier]);
  React.useEffect(() => {
    if (!draft.externalInput || !snapshot?.turns.some((turn) => turn.key === draft.externalInput!.key))
      return;
    useThreadDraftStore.getState().patch(key, current => ({ externalInput: undefined,
      text: current.text === draft.externalInput!.text ? '' : current.text,
      files: current.files?.filter(file => !draft.externalInput!.attachments?.some(selected => 'ref' in selected && selected.ref === file.attachment?.ref)),
    }));
  }, [snapshot?.turns, draft.externalInput, key]);
  const act = async (operation: () => Promise<unknown>, refresh = false) => {
    if (acting.current || !isCurrent()) return;
    acting.current = true;
    setPending(true); setError(''); setFailure(undefined);
    try {
      await operation();
      if (refresh && isCurrent()) await refreshView.current();
    } catch (error) {
      if (isCurrent()) setFailure(error);
    } finally {
      acting.current = false;
      if (isCurrent()) setPending(false);
    }
  };
  const insertImageReference = (number: number) => {
    const token = t('chat.imageReference.token', { number });
    if (editor.current) editor.current.insertText(token);
    else useThreadDraftStore.getState().patch(key, current => ({ text: current.text + token }));
  };
  const addFiles = (files: File[]) => {
    if (!isCurrent() || acting.current || draft.externalInput) return;
    if (files.some(file => !externalAttachmentSupported(snapshot?.capabilities ?? (snapshot ? settings?.capabilityCache?.[snapshot.conversation.configurationId]?.capabilities : undefined), file))) { setFailure(new Error(t('external.filesUnsupported'))); return; }
    selectThreadFiles(key, files, insertImageReference);
  };
  if (!snapshot)
    return (
      <p role="status" className="p-6 text-muted-foreground">
        {error || t('common.loading')}
      </p>
    );
  const c = snapshot.conversation,
    activeTurn = c.activeTurn,
    active = snapshot.turns.find((v) => v.id === activeTurn);
  const last = snapshot.turns.at(-1),
    queued = snapshot.turns.filter((v) => v.status === 'queued');
  const capabilities = snapshot.capabilities ?? settings?.capabilityCache?.[c.configurationId]?.capabilities;
  const capabilitiesSource = snapshot.capabilities ? snapshot.capabilitiesSource ?? (snapshot.connected ? 'live' : 'cached') : capabilities ? 'cached' : undefined;
  const model = draft.externalModels?.[c.configurationId] ?? '';
  const unresolvedInput = Boolean(draft.externalInput && !pending);
  const options = draft.externalOptions?.[c.configurationId] ?? {};
  const choice = { model, ...options };
  const changeChoice = (value: import('./externalSessionChoice').ExternalSessionChoice) => patch({
    externalModels: { ...draft.externalModels, [c.configurationId]: value.model ?? '' },
    externalOptions: { ...draft.externalOptions, [c.configurationId]: { thinking: value.thinking, mode: value.mode, config: value.config } },
  });
  const errorText = failure instanceof Error ? failure.message : failure ? String(failure) : error;
  const messages = [...new Map([...earlier, ...snapshot.items].map((item) => [item.id, item])).values()].filter(item => !turnId || item.turnId === turnId);
  const controls = <button type="button" title={t('external.details')} onClick={() => setDetails(true)}><HarnessSelector value={c.configurationId} /></button>;
  return (
    <section className="regular-chat-view relative flex h-full min-h-0 min-w-0 flex-col">
      <div ref={track} className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={bindViewport}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onScroll={(event) => {
              const node = event.currentTarget;
              follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            <div className="chat-input-column space-y-4 py-6">
              <ToolDisclosureScope sessionId={id}>
                {turnId && <p role="status">{t('arrangements.externalTurn', { turn: turnId, state: externalFollowupState(snapshot.turns.find(turn => turn.id === turnId)?.status ?? '', t) })}</p>}
                {turnId && !messages.length && <p>{t('arrangements.externalTurnEmpty', { turn: turnId })}</p>}
                {previous && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      void act(async () => {
                        const page = await api.read(id, previous);
                        if (!isCurrent()) return;
                        const node = viewport.current;
                        if (node) prepend.current = { height: node.scrollHeight, top: node.scrollTop };
                        follow.current = false;
                        setEarlier((old) => [...page.items, ...old]);
                        setPrevious(page.previous ?? null);
                      })
                    }
                  >
                    {t('external.history')}
                  </Button>
                )}
                <ImageReplyDraftContext.Provider value={readOnly?null:key}><Messages readAttachment={(ref, signal) => api.readAttachment(id, ref, signal)} items={messages} activeTurn={activeTurn} cwd={c.cwd} receipts={snapshot.turns} /></ImageReplyDraftContext.Provider>
              </ToolDisclosureScope>
            </div>
          </div>
          {!readOnly && (
            <div className="shrink-0 pb-4 pt-2">
              <div className="chat-input-column">
                {snapshot.interactions.map((request) => (
                  <ExternalInteractionForm
                    key={request.id}
                    request={request}
                    pending={pending}
                    respond={(answer) => void act(() => api.respond(id, request.id, answer), true)}
                  />
                ))}
                {unresolvedInput && (
                  <div className="mb-3 typography-meta text-muted-foreground">
                    <p>{t('external.sendUnconfirmed')}</p>
                    <p className="line-clamp-2 whitespace-pre-wrap">{draft.externalInput!.text}</p>
                    <Button
                      variant="ghost"
                      disabled={pending || c.needsReview}
                      onClick={() =>
                        void act(async () => {
                          const ready = await ensureConnected(); if (!ready || !isCurrent()) return;
                          if (!ready.connected || ready.capabilitiesSource === 'cached') throw new Error(t('external.prepareHint'));
                          const request = draft.externalInput!;
                          await api.send(id, request.key, request);
                          if (!isCurrent()) return;
                          patch({ externalInput: undefined, text: draft.text === request.text ? '' : draft.text, files: draft.files?.filter(file => !request.attachments?.some(selected => 'ref' in selected && selected.ref === file.attachment?.ref)) });
                        })
                      }
                    >
                      {t('external.confirmSend')}
                    </Button>
                  </div>
                )}
                {c.needsReview && (
                  <div className="mb-3 typography-meta text-muted-foreground">
                    {t('external.review')}
                    <Button
                      variant="ghost"
                      disabled={pending || !snapshot.connected}
                      onClick={() => void act(() => api.continueConversation(id), true)}
                    >
                      {t('external.continue')}
                    </Button>
                  </div>
                )}
                {active?.status === 'stopping' && <div className="mb-3 space-y-2 typography-meta text-muted-foreground">
                  <p>{t('external.terminateHint')}</p>
                  <Button type="button" variant="outline" disabled={terminating} onClick={() => {
                    if (terminatingRef.current || !isCurrent()) return;
                    terminatingRef.current = true; setTerminating(true);
                    void api.stop(id, active.id, true).then(async () => {
                      if (!isCurrent()) return;
                      await refreshView.current();
                    }).catch(error => { if (isCurrent()) setFailure(error); }).finally(() => {
                      terminatingRef.current = false; if (isCurrent()) setTerminating(false);
                    });
                  }}>{t('external.terminate')}</Button>
                </div>}
                {queued.length > 0 && (
                  <p className="mb-2 typography-meta text-muted-foreground">
                    {t('external.queued')} · {queued.length}
                  </p>
                )}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (acting.current || pending || unresolvedInput || c.needsReview || capabilities?.images === false && draft.images.length || (!draft.text.trim() && !draft.images.length && !draft.files?.length)) return;
                  const originalText = draft.text, originalImages = draft.images, originalFiles = draft.files;
                  void act(async () => {
                    const ready = await ensureConnected(); if (!ready || !isCurrent()) return;
                    if (!ready.connected || !ready.capabilities || ready.capabilitiesSource === 'cached' || ready.conversation.needsReview) throw new Error(t(ready.conversation.needsReview ? 'external.review' : 'external.prepareHint'));
                    if (draft.images.length && !ready.capabilities.images) throw new Error(t('external.imagesUnsupported'));
                    if (draft.files?.some(file => !externalAttachmentSupported(ready.capabilities, file))) throw new Error(t('external.filesUnsupported'));
                    const attachments = draft.externalInput ? [] : await prepareDraftFiles(key, draft.files ?? [], `external:${id}`,
                      (file, signal) => api.uploadAttachment(id, { key: file.uploadKey ?? file.id, filename: file.filename, mimeType: file.mimeType, data: file.data }, signal));
                    if (!isCurrent()) return;
                    const request = draft.externalInput ?? { key: crypto.randomUUID(), text: draft.text,
                      images: (await prepareAnnotatedImages(draft.images)).map(v => ({ data: v.data, mimeType: v.mimeType })), attachments: attachments.map(({ ref }) => ({ ref })), ...attachmentImageReferences(draft.files ?? [], attachments),
                      ...externalSessionInput(normalizeExternalSessionChoice(choice, ready.capabilities), ready.capabilities) };
                    if (!isCurrent()) return;
                    patch({ externalInput: request });
                    try {
                      await api.send(id, request.key, request);
                    } catch (error) {
                      if (
                        isCurrent() && error instanceof ExternalAgentError &&
                        error.status >= 400 &&
                        error.status < 500 &&
                        error.code !== 'host_changed' &&
                        error.code !== 'input_changed'
                      )
                        patch({ externalInput: undefined });
                      throw error;
                    }
                    if (!isCurrent()) return;
                    const current = useThreadDraftStore.getState().drafts[key];
                    patch({
                      ...(current?.text === originalText ? { text: '' } : {}),
                      ...(current?.images === originalImages ? { images: [] } : {}),
                      files: current?.files?.filter(file => !originalFiles?.some(original => original.id === file.id)),
                      externalInput: undefined,
                    });
                    follow.current = true;
                    await useExternalAgentStore.getState().refresh();
                  });
                }}
              >
                <input type="file" accept="image/*" multiple hidden ref={imageInput} onChange={event => {
                  const files = [...(event.target.files ?? [])]; event.target.value = ''; addFiles(files);
                }} />
                <input
                  type="file"
                  multiple
                  hidden
                  ref={fileInput}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void addFiles(files);
                  }}
                />
                <ThreadComposer
                  editorRef={editor}
                  value={draft.text}
                  onChange={(text, references) => patch({ text, references })}
                  references={draft.references} backendIdentity={`${c.configurationId}:${c.id}`}
                  identityKey={key}
                  models={[]}
                  providerId=""
                  modelId=""
                  thinkingLevel="off"
                  onModelChange={() => {}}
                  backendControls={controls}
                  external={{ capabilities, source: capabilitiesSource, choice, disabled: pending || unresolvedInput, retryDisabled: Boolean(active) || queued.length > 0, retryDisabledReason: snapshot.connected && capabilities?.resume === false && !capabilities.modelsRefresh ? t('external.reconnectUnsupported') : undefined, onChange: changeChoice,
                    onInteract: kind => { if (kind !== 'input' || !failure) void ensureConnected().catch(() => {}); }, onRetryModels: () => { void ensureConnected(capabilities?.modelsRefresh ? 'models' : true).catch(() => {}); } }}
                  connectionStatus={<ExternalConnectionStatus snapshot={snapshot} name={settings?.agents.find(agent => agent.id === c.configurationId)?.name}
                    busy={connecting} cancelling={cancelling} error={failure ?? (errorText || undefined)} reconnectDisabled={pending || Boolean(active) || queued.length > 0}
                    onReconnect={() => { void ensureConnected(true).catch(() => {}); }} onCancel={() => { void cancelConnection(); }}
                    onAuthenticate={methodId => { void act(() => api.authenticate(id, methodId), true); }} />}
                  backendCommands={capabilities?.commands}
                  commandActions={{ tree: { run: () => setDetails(true) },
                    new: { run: async () => { const next = await startThreadFromNavigation({ directory: c.cwd }); if (host === getRuntimeEndpointGeneration()) useThreadDraftStore.getState().patch(next, { harnessId: c.configurationId }); } },
                    rename: { content: complete => <ComposerActionForm initial={c.title} label={t('composer.name')} confirm={async title => { if (host !== getRuntimeEndpointGeneration()) throw new Error(t('composer.scope.changed')); await useExternalAgentStore.getState().update(id, { title }); }} onDone={complete} /> },
                    pin: { run: () => useExternalAgentStore.getState().update(id, { pinned: !c.pinned }), value: t(c.pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin') },
                    archive: { run: () => useExternalAgentStore.getState().update(id, { archived: !c.archived }) },
                    delete: { content: complete => <ComposerActionForm danger description={t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: c.title })} confirm={() => useExternalAgentStore.getState().update(id, { deleted: true })} onDone={complete} /> },
                    terminal: { run: () => useUIStore.getState().openContextSurface(c.cwd, 'terminal') },
                  }}
                  modelDisabled={pending}
                  attachmentDisabled={pending || unresolvedInput}
                  imageDisabled={!capabilities?.images}
                  sendDisabled={pending || unresolvedInput || Boolean(c.needsReview) || capabilities?.images === false && Boolean(draft.images.length) || (!draft.text.trim() && !draft.images.length && !draft.files?.length)}
                  pending={pending}
                  active={Boolean(active)}
                  retrying={false}
                  onFiles={(files) => void addFiles(files)}
                  onAttachImages={() => imageInput.current?.click()}
                  onAttachPdfs={() => fileInput.current?.click()}
                  onStop={active ? () => void act(() => api.stop(id, active.id)) : undefined}
                  onGoal={() => {}}
                  hasInput={Boolean(draft.text.trim() || draft.images.length || draft.files?.length)}
                  onWorkspace={() => setDetails(true)}
                  workspaceLabel={c.cwd.split(/[\\/]/).at(-1) ?? c.cwd}
                  workspacePath={c.cwd}
                  imageReferences={draftImageReferences(draft)} attachmentNames={draft.files?.map(file => file.filename) ?? []}
                  skills={[]}
                >
                  <ThreadFileDrafts draftKey={key} onReference={insertImageReference} files={draft.files} locked={pending || unresolvedInput} onRemove={id => removeDraftFile(key, id)} />
                  <ImageAttachmentStrip
                    key={key}
                    images={draft.images}
                    onUpdate={pending || unresolvedInput ? undefined : (index,image)=>patch({images:draft.images.map((current,i)=>i===index?image:current)})}
                    onRemove={(index) => removeDraftImage(key, index)}
                    onReference={(number) =>
                      editor.current?.insertText(t('chat.imageReference.token', { number }))
                    }
                  />
                </ThreadComposer>
              </form>
            </div>
          )}
        </div>
        <ExternalOverview
          id={id}
          status={active?.status ?? last?.status}
          planText={snapshot.items.filter((item) => item.kind === 'plan').at(-1)?.text}
          cwd={c.cwd}
          connected={snapshot.connected}
        />
        {scrollElement && <ConversationScrollbar viewport={scrollElement} trackRef={track} />}
      </div>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('external.details')}</DialogTitle>
          </DialogHeader>
          <dl className="space-y-3 typography-meta">
            <div>
              <dt>{c.harness}</dt>
              <dd className="break-all text-muted-foreground">{c.cwd}</dd>
            </div>
            <div>
              <dt>{snapshot.connected ? t('external.connected') : t('external.disconnected')}</dt>
              <dd className="break-all text-muted-foreground">{c.sessionId}</dd>
            </div>
            {snapshot.capabilities?.protocol && <div><dt>{t('external.protocol')}</dt><dd className="text-muted-foreground">
              {snapshot.capabilities.protocol.name} · {snapshot.capabilities.protocol.version} · {snapshot.capabilities.protocol.agentVersion}
            </dd></div>}
          </dl>
          {snapshot.connected && capabilities?.resume === false && <p className="typography-meta text-muted-foreground">{t('external.reconnectUnsupported')}</p>}
          <Button
            disabled={pending || connecting || readOnly || Boolean(active) || queued.length > 0 || snapshot.connected && capabilities?.resume === false}
            onClick={() => { void ensureConnected(true).catch(() => {}); }}
          >
            {t('external.reconnect')}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
