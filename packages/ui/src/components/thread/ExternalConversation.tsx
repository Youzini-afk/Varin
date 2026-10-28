import React from 'react';
import {
  createExternalAgentsHttpAPI,
  ExternalAgentError,
  getRuntimeEndpointGeneration,
  type ExternalConversationSnapshot,
  type ExternalInteraction,
  type ExternalItem,
  type ExternalTurn,
  type ExternalObservation,
} from '@varin/application-client';
import { useExternalAgentStore } from '@/stores/useExternalAgentStore';
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
import {
  beginImageInsertion,
  fileToImageAttachment,
  removeDraftImage,
} from '@/components/chat/composer/imageAttachments';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { ConversationScrollbar } from '@/components/conversation/ConversationScrollbar';
import { ExternalOverview } from './ExternalOverview';
import { ChatFileChangePreview } from '@/components/conversation/ChatFileChangePreview';
import type { FileChangePreview } from '@/components/conversation/fileChangePreview';
import { PartialJson } from '@/lib/interactive-ui/partial-json';
import { openFileInMainEditor } from '@/lib/openFileInMainEditor';
import { toast } from '@/components/ui';
import { ChatAgentMessageBubble } from '@/components/conversation/ChatAgentMessageBubble';

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
}: {
  item: ExternalItem;
  active: boolean;
  expanded?: boolean;
  cwd: string;
}) {
  const { t } = useI18n();
  const [image, setImage] = React.useState<string>();
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
              onClick={() => setImage(`data:${value.mimeType};base64,${value.data}`)}
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
      <Dialog
        open={Boolean(image)}
        onOpenChange={(open) => {
          if (!open) setImage(undefined);
        }}
      >
        <DialogContent className="max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>{t('chat.imageReference.token', { number: 1 })}</DialogTitle>
          </DialogHeader>
          {image && <img src={image} alt="" className="max-h-[80vh] w-full object-contain" />}
        </DialogContent>
      </Dialog>
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
}: {
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
              <Item
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
                    <Item key={item.id} item={item} cwd={cwd} active={item.turnId === activeTurn} />
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
function Interaction({
  request,
  pending,
  respond,
}: {
  request: ExternalInteraction;
  pending: boolean;
  respond(value: { optionId?: string; answers?: Record<string, string[]>; text?: string }): void;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({});
  const [free, setFree] = React.useState<Record<string, string>>({});
  const [value, setValue] = React.useState('');
  return (
    <section
      className="mb-3 max-h-[50vh] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg"
      aria-label={request.title}
    >
      <p className="mb-3 font-medium">{request.title}</p>
      {request.detail && (
        <pre className="mb-3 whitespace-pre-wrap break-all typography-meta text-muted-foreground">
          {request.detail}
        </pre>
      )}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          respond({
            answers: Object.fromEntries(
              (request.questions ?? []).map((q) => [
                q.id,
                [...(answers[q.id] ?? []), ...(free[q.id]?.trim() ? [free[q.id]!] : [])],
              ]),
            ),
            text: value,
          });
        }}
      >
        {request.questions?.map((q) => (
          <fieldset key={q.id} className="space-y-2">
            <legend className="mb-2 typography-meta font-medium">{q.question}</legend>
            {q.options?.map((option) => (
              <label
                key={option.label}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3 typography-meta hover:bg-muted"
              >
                <input
                  className="mt-1 shrink-0 accent-[var(--primary)]"
                  type={q.multiple ? 'checkbox' : 'radio'}
                  name={q.id}
                  disabled={pending}
                  checked={answers[q.id]?.includes(option.label) ?? false}
                  onChange={(event) =>
                    setAnswers((old) => ({
                      ...old,
                      [q.id]: q.multiple
                        ? event.target.checked
                          ? [...(old[q.id] ?? []), option.label]
                          : (old[q.id] ?? []).filter((v) => v !== option.label)
                        : [option.label],
                    }))
                  }
                />
                <span className="min-w-0 break-words">
                  {option.label}
                  {option.description && (
                    <span className="mt-1 block text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
            <textarea
              className="min-h-16 w-full rounded-lg border border-border bg-background p-3 typography-meta"
              aria-label={`${q.question} · ${t('external.answer')}`}
              value={free[q.id] ?? ''}
              onChange={(event) => setFree((old) => ({ ...old, [q.id]: event.target.value }))}
            />
          </fieldset>
        ))}
        {request.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => respond({ optionId: option.id })}
            className="mr-2 whitespace-normal text-left"
          >
            {option.label}
          </Button>
        ))}
        {!request.options.length && !request.questions?.length && (
          <textarea
            className="min-h-20 w-full rounded-lg border border-border bg-background p-3"
            aria-label={t('external.answer')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        {!request.options.length && (
          <Button type="submit" disabled={pending}>
            {t('external.confirm')}
          </Button>
        )}
      </form>
    </section>
  );
}
export function ExternalConversationView({ id, readOnly = false }: { id: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const host = getRuntimeEndpointGeneration();
  const api = React.useMemo(() => createExternalAgentsHttpAPI(host), [host]);
  const [snapshot, setSnapshot] = React.useState<ExternalConversationSnapshot>();
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [details, setDetails] = React.useState(false);
  const [earlier, setEarlier] = React.useState<ExternalItem[]>([]);
  const [previous, setPrevious] = React.useState<number | null>();
  const editor = React.useRef<ComposerEditorHandle | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
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
          const value = await api.read(id, undefined, controller.signal);
          if (!controller.signal.aborted) {
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
    void refresh();
    void api
      .observe(
        id,
        (event) => {
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
    };
  }, [api, id]);
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
    useThreadDraftStore.getState().patch(key, { externalInput: undefined });
  }, [snapshot?.turns, draft.externalInput, key]);
  const act = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      if (host === getRuntimeEndpointGeneration())
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (host === getRuntimeEndpointGeneration()) setPending(false);
    }
  };
  const addFiles = async (files: File[]) => {
    const insertion = beginImageInsertion(key, editor.current, (number) =>
      t('chat.imageReference.token', { number }),
    );
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) throw new Error(t('external.attachments'));
        insertion.append(await fileToImageAttachment(file));
      }
    } catch (error) {
      setError(String(error));
    } finally {
      insertion.dispose();
    }
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
  const model = draft.externalModels?.[c.configurationId] ?? '';
  const unresolvedInput = Boolean(draft.externalInput && !pending);
  const options = draft.externalOptions?.[c.configurationId] ?? {};
  const option = (value: { thinking?: string; mode?: string }) =>
    patch({ externalOptions: { ...draft.externalOptions, [c.configurationId]: { ...options, ...value } } });
  const thinking = snapshot.capabilities?.models.find((m) => m.id === model)?.thinkingLevels;
  const messages = [...new Map([...earlier, ...snapshot.items].map((item) => [item.id, item])).values()];
  const controls = (
    <>
      {thinking?.length ? (
        <Select
          value={options.thinking || '__default'}
          onValueChange={(value) => option({ thinking: value === '__default' ? '' : value })}
        >
          <SelectTrigger
            className="h-7 w-auto border-none bg-transparent typography-meta"
            aria-label={t('chat.context.thinking')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default">{t('chat.modelControls.default')}</SelectItem>
            {thinking.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {snapshot.capabilities?.models.length ? (
        <Select
          value={model || '__default'}
          disabled={pending}
          onValueChange={(value) =>
            patch({
              externalModels: {
                ...draft.externalModels,
                [c.configurationId]: value === '__default' ? '' : value,
              },
            })
          }
        >
          <SelectTrigger className="h-7 w-auto max-w-56 border-none bg-transparent typography-meta">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default">{t('external.inherit')}</SelectItem>
            {snapshot.capabilities.models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <input
          className="w-40 min-w-0 bg-transparent typography-meta text-muted-foreground outline-none"
          aria-label={t('external.model')}
          placeholder={t('external.inherit')}
          value={model}
          onChange={(event) =>
            patch({ externalModels: { ...draft.externalModels, [c.configurationId]: event.target.value } })
          }
        />
      )}
      <button type="button" title={t('external.details')} onClick={() => setDetails(true)}>
        <HarnessSelector value={c.configurationId} />
      </button>
      {snapshot.capabilities?.modes?.length ? (
        <Select
          value={options.mode || '__default'}
          onValueChange={(value) => option({ mode: value === '__default' ? '' : value })}
        >
          <SelectTrigger
            className="h-7 w-auto border-none bg-transparent typography-meta"
            aria-label={t('external.mode')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default">{t('external.inherit')}</SelectItem>
            {snapshot.capabilities.modes.map((mode) => (
              <SelectItem key={mode.id} value={mode.id}>
                {mode.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </>
  );
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
                {previous && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      void act(async () => {
                        const page = await api.read(id, previous);
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
                <Messages items={messages} activeTurn={activeTurn} cwd={c.cwd} receipts={snapshot.turns} />
              </ToolDisclosureScope>
            </div>
          </div>
          {!readOnly && (
            <div className="shrink-0 pb-4 pt-2">
              <div className="chat-input-column">
                {snapshot.interactions.map((request) => (
                  <Interaction
                    key={request.id}
                    request={request}
                    pending={pending}
                    respond={(answer) => void act(() => api.respond(id, request.id, answer))}
                  />
                ))}
                {error && (
                  <p role="alert" className="mb-3 break-words typography-meta text-destructive">
                    {error}
                  </p>
                )}
                {unresolvedInput && (
                  <div className="mb-3 typography-meta text-muted-foreground">
                    <p>{t('external.sendUnconfirmed')}</p>
                    <p className="line-clamp-2 whitespace-pre-wrap">{draft.externalInput!.text}</p>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void act(async () => {
                          const request = draft.externalInput!;
                          await api.send(id, request.key, request);
                          patch({ externalInput: undefined });
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
                      disabled={pending}
                      onClick={() => void act(() => api.connect(id))}
                    >
                      {t('external.connect')}
                    </Button>
                  </div>
                )}
                {queued.length > 0 && (
                  <p className="mb-2 typography-meta text-muted-foreground">
                    {t('external.queued')} · {queued.length}
                  </p>
                )}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (pending || unresolvedInput || (!draft.text.trim() && !draft.images.length)) return;
                  const request = draft.externalInput ?? {
                    key: crypto.randomUUID(),
                    text: draft.text,
                    images: draft.images.map((v) => ({ data: v.data, mimeType: v.mimeType })),
                    ...(model ? { model } : {}),
                    ...options,
                  };
                  patch({ externalInput: request });
                  const originalText = draft.text,
                    originalImages = draft.images;
                  void act(async () => {
                    try {
                      await api.send(id, request.key, request);
                    } catch (error) {
                      if (
                        error instanceof ExternalAgentError &&
                        error.status >= 400 &&
                        error.status < 500 &&
                        error.code !== 'host_changed' &&
                        error.code !== 'input_changed'
                      )
                        patch({ externalInput: undefined });
                      throw error;
                    }
                    const current = useThreadDraftStore.getState().drafts[key];
                    patch({
                      ...(current?.text === originalText ? { text: '' } : {}),
                      ...(current?.images === originalImages ? { images: [] } : {}),
                      externalInput: undefined,
                    });
                    follow.current = true;
                    await useExternalAgentStore.getState().refresh();
                  });
                }}
              >
                <input
                  type="file"
                  accept="image/*"
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
                  onChange={(text) => patch({ text })}
                  identityKey={key}
                  models={[]}
                  providerId=""
                  modelId=""
                  thinkingLevel="off"
                  onModelChange={() => {}}
                  backendControls={controls}
                  modelDisabled={pending}
                  attachmentDisabled={pending}
                  imageDisabled={snapshot.capabilities?.images === false}
                  sendDisabled={pending || unresolvedInput || (!draft.text.trim() && !draft.images.length)}
                  pending={pending}
                  active={Boolean(active)}
                  retrying={false}
                  onFiles={(files) => void addFiles(files)}
                  onAttachImages={() => fileInput.current?.click()}
                  onAttachPdfs={() => setError(t('external.attachments'))}
                  onStop={active ? () => void act(() => api.stop(id, active.id)) : undefined}
                  onGoal={() => {}}
                  hasInput={Boolean(draft.text.trim() || draft.images.length)}
                  onWorkspace={() => setDetails(true)}
                  workspaceLabel={c.cwd.split(/[\\/]/).at(-1) ?? c.cwd}
                  workspacePath={c.cwd}
                  attachmentNames={[]}
                  skills={[]}
                >
                  <ImageAttachmentStrip
                    images={draft.images}
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
          </dl>
          <Button
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await api.connect(id);
                setSnapshot(await api.read(id));
              })
            }
          >
            {t('external.connect')}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
