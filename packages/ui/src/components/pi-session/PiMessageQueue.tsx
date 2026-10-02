import React from 'react';
import type { QueuedUserMessage, RuntimeMethodParams, RuntimeMethodResult } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';

export type QueueUpdate = Omit<RuntimeMethodParams<'agent.queue.update'>, 'sessionId'>;

interface Props {
  messages: readonly QueuedUserMessage[];
  working: boolean;
  onUpdate(update: QueueUpdate): Promise<RuntimeMethodResult<'agent.queue.update'>>;
  onClear(): Promise<void>;
}

const actionClass = 'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 typography-meta text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40';

/** Presentation of the native Pi queue; no local admission/dequeue authority. */
export function PiMessageQueue({ messages, working, onUpdate, onClear }: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState<QueuedUserMessage | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const update = (message: QueuedUserMessage, action: QueueUpdate['action'], text?: string) => run(async () => {
    const result = await onUpdate({ id: message.id, revision: message.revision, action, ...(text === undefined ? {} : { text }) });
    if (!mounted.current) return;
    if (result.status !== 'updated') {
      setError(t(result.status === 'missing' ? 'chat.queuedMessage.unavailable' : 'chat.queuedMessage.changed'));
    } else if (action === 'edit') setEditing(null);
  });
  const beginEdit = (message: QueuedUserMessage) => { setError(null); setEditing({ ...message }); };
  const cancelEdit = () => { setEditing(null); setError(null); };
  const editIsCurrent = editing && messages.some((message) => message.id === editing.id && message.revision === editing.revision);

  const editor = editing ? (
    <div className="space-y-2 px-3 py-2" data-pi-queue-editor="true">
      <textarea
        autoFocus
        aria-label={t('chat.queuedMessage.edit')}
        value={editing.text}
        disabled={pending}
        rows={3}
        onInput={(event) => setEditing({ ...editing, text: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (isIMECompositionEvent(event)) return;
          if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault(); event.stopPropagation();
            if (editIsCurrent && (editing.text.trim() || editing.imageCount)) void update(editing, 'edit', editing.text);
          }
        }}
        className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 typography-meta text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
      {editing.imageCount > 0 && <p className="typography-meta text-muted-foreground">{t('chat.queuedMessage.imagesKept', { count: editing.imageCount })}</p>}
      {!editIsCurrent && <p role="status" className="typography-meta text-muted-foreground">{t('chat.queuedMessage.editStale')}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={actionClass} disabled={pending} onClick={cancelEdit}>{t('settings.common.actions.cancel')}</button>
        <button type="button" className={actionClass} disabled={pending || !editIsCurrent || (!editing.text.trim() && !editing.imageCount)} onClick={() => void update(editing, 'edit', editing.text)}>{t('settings.common.actions.saveChanges')}</button>
      </div>
    </div>
  ) : null;

  if (!messages.length && !editing && !error) return null;
  return (
    <section className="mb-2 overflow-hidden rounded-xl border border-border/60 bg-muted/15" data-pi-runtime-queue="true" aria-busy={pending} aria-label={t('chat.queuedMessage.title')}>
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-1.5">
        <span className="typography-meta font-medium text-foreground">{t('chat.queuedMessage.title')} · {messages.length}</span>
        <button type="button" className={actionClass} disabled={pending || messages.length === 0} onClick={() => void run(onClear)}>{t('chat.queuedMessage.clearAll')}</button>
      </div>
      <div className="max-h-[40vh] divide-y divide-border/40 overflow-y-auto overscroll-contain">
        {messages.map((message) => (
          <div key={message.id} data-pi-queued-message={message.id}>
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1 basis-40">
                <div className="mb-0.5 flex items-center gap-2 typography-micro text-muted-foreground">
                  <Icon name={message.mode === 'steer' ? 'arrow-up' : 'time'} className="size-3" />
                  <span>{t(message.mode === 'steer' ? 'chat.queuedMessage.steering' : 'chat.queuedMessage.waiting')}</span>
                  {message.imageCount > 0 && <span>{t('chat.queuedMessage.images', { count: message.imageCount })}</span>}
                </div>
                {editing?.id !== message.id && <p className="line-clamp-3 whitespace-pre-wrap break-words typography-meta text-foreground">{message.text || t('chat.queuedMessage.empty')}</p>}
              </div>
              <div className="ml-auto flex items-center gap-0.5">
                {(message.mode === 'followUp' || !working) && <button type="button" className={actionClass} disabled={pending || editing !== null} title={t('chat.queuedMessage.sendHint')} onClick={() => void update(message, 'steer')}><Icon name="arrow-up" className="size-3.5" />{t('chat.queuedMessage.sendNow')}</button>}
                <button type="button" className={actionClass} disabled={pending || editing !== null} aria-label={t('chat.queuedMessage.edit')} title={t('chat.queuedMessage.edit')} onClick={() => beginEdit(message)}><Icon name="pencil" className="size-3.5" /></button>
                <button type="button" className={actionClass} disabled={pending || editing !== null} aria-label={t('chat.queuedMessage.removeAria')} title={t('chat.queuedMessage.removeAria')} onClick={() => void update(message, 'remove')}><Icon name="close" className="size-3.5" /></button>
              </div>
            </div>
            {editing?.id === message.id && editor}
          </div>
        ))}
        {editing && !messages.some((message) => message.id === editing.id) && editor}
      </div>
      {error && <div role="alert" className="flex items-center justify-between gap-2 border-t border-border/40 px-3 py-2 typography-meta text-destructive"><span>{error}</span><button type="button" className={actionClass} aria-label={t('dialog.common.actions.close')} onClick={() => setError(null)}><Icon name="close" className="size-3.5" /></button></div>}
    </section>
  );
}
