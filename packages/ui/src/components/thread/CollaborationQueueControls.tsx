import React from 'react';
import type { ThreadsAPI } from '@varin/application-client';
import type { MessageFeedEntry } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';

export function CollaborationQueueControls({ api, message, onChanged }: {
  api: ThreadsAPI; message: MessageFeedEntry; onChanged(): void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(message.text);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const editor = React.useRef<HTMLTextAreaElement>(null);
  const open = () => { setText(message.text); setEditing(true); };
  React.useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);
  const act = async (action: 'send_now' | 'cancel' | 'edit') => {
    if (busy || message.revision === undefined) return;
    if (action === 'edit' && !text.trim() && !message.attachments.length) return;
    setBusy(true); setError(undefined);
    try {
      await api.messages!.control({ runtime: 'agent', threadId: message.senderThreadId, branchId: message.senderBranchId }, {
        messageId: message.messageId, expectedRevision: message.revision, action, ...(action === 'edit' ? { text } : {}),
      });
      setEditing(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); onChanged(); }
  };
  return <div className="collaboration-queue-controls" aria-busy={busy}>
    <div className="collaboration-queue-actions">
      <span className="collaboration-queue-state"><Icon name="time" className="size-3.5" />
        {t(message.afterCurrent ? 'collaboration.queue.waiting' : 'chat.messages.queued')}</span>
      {message.afterCurrent && <button type="button" disabled={busy} onClick={() => void act('send_now')}>
        <Icon name="arrow-up" className="size-3.5" />{t('collaboration.queue.sendNow')}
      </button>}
      {message.actor.kind === 'user' && <button type="button" disabled={busy} onClick={open}>{t('collaboration.queue.edit')}</button>}
      <button type="button" disabled={busy} onClick={() => void act('cancel')}>{t('collaboration.queue.withdraw')}</button>
    </div>
    <div className="collaboration-queue-editor" data-open={editing} aria-hidden={!editing} inert={!editing}>
      <div>
        <Textarea ref={editor} value={text} disabled={busy} rows={3} aria-label={t('chat.messages.text')}
          onChange={event => setText(event.target.value)} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void act('edit'); }
          }} />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('collaboration.queue.cancelEdit')}</Button>
          <Button size="sm" disabled={busy || (!text.trim() && !message.attachments.length)} onClick={() => void act('edit')}>{t('collaboration.queue.save')}</Button>
        </div>
      </div>
    </div>
    {error && <p role="alert" className="mt-2 typography-micro text-destructive">{error}</p>}
  </div>;
}
