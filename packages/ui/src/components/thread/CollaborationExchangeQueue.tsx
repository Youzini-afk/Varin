import React from 'react';
import type { ThreadsAPI, ThreadQueuedExchange } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { FlipList } from '@/components/conversation/FlipList';

function Exchange({ api, value, onChanged }: { api: ThreadsAPI; value: ThreadQueuedExchange; onChanged(): void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const act = async (action: 'send_now' | 'cancel' | 'retry') => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await api.collaboration!.controlExchange({ runtime: 'agent', threadId: value.senderThreadId, branchId: value.senderBranchId }, {
        operationId: value.operationId, expectedRevision: value.revision, action,
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); onChanged(); }
  };
  return <Collapsible open={expanded} onOpenChange={setExpanded} className="collaboration-exchange-queued">
    <div className="flex min-w-0 items-start gap-2">
      <Icon name="file-transfer" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 typography-micro">
          <span className="truncate">{value.source.name}</span><Icon name="arrow-right" className="size-3 text-muted-foreground" />
          <span className="truncate">{value.target.name}</span>
        </div>
        <CollapsibleTrigger className="mt-1 justify-start gap-1 p-0 text-muted-foreground hover:bg-transparent typography-micro">
          <span>{t('collaboration.fileCount', { count: value.files.length })}</span>
          <Icon name="arrow-down-s" className="size-3 transition-transform duration-200" style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
        </CollapsibleTrigger>
      </div>
      <span role="status" className="shrink-0 typography-micro text-muted-foreground">
        {t(value.state === 'needs_attention' ? 'collaboration.exchangeAttention' : value.state === 'applying' ? 'collaboration.queue.applying' : value.state === 'withdrawing' ? 'collaboration.queue.withdrawing'
          : value.afterCurrent ? 'collaboration.queue.waiting' : 'collaboration.queue.sending')}
      </span>
    </div>
    <CollapsibleContent><div className="collaboration-queued-files">{value.files.map(path => <div key={path}>{path}</div>)}</div></CollapsibleContent>
    {value.state === 'queued' && <div className="collaboration-queue-actions mt-2 pl-6">
      {value.afterCurrent && <button disabled={busy} type="button" onClick={() => void act('send_now')}><Icon name="arrow-up" className="size-3" />{t('collaboration.queue.sendNow')}</button>}
      <button disabled={busy} type="button" onClick={() => void act('cancel')}>{t('collaboration.queue.withdraw')}</button>
    </div>}
    {value.state === 'needs_attention' && <button type="button" className="mt-2 typography-micro text-primary" disabled={busy} onClick={() => void act('retry')}>{t('chat.family.retry')}</button>}
    {error && <p role="alert" className="mt-2 typography-micro text-destructive">{error}</p>}
  </Collapsible>;
}
export function CollaborationExchangeQueue({ api, values, onChanged }: { api: ThreadsAPI; values: ThreadQueuedExchange[]; onChanged(): void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(true);
  const last = React.useRef(values);
  if (values.length) last.current = values;
  return <Collapsible open={Boolean(values.length)} className="collaboration-exchange-queue">
    <CollapsibleContent keepMounted inert={!values.length}>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="px-4 py-2 typography-micro text-muted-foreground hover:bg-transparent">
          <span className="flex items-center gap-2"><Icon name="time" className="size-3.5" />{t('collaboration.queue.exchanges', { count: values.length || last.current.length })}</span>
          <Icon name="arrow-down-s" className="size-3.5 transition-transform duration-200" style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
        </CollapsibleTrigger>
        <CollapsibleContent><FlipList className="collaboration-exchange-queue-list" layoutKey={values.map(value => value.operationId).join('|')}>{(values.length ? values : last.current).map(value =>
          <div key={value.operationId} data-flip-key={value.operationId}><Exchange api={api} value={value} onChanged={onChanged} /></div>)}</FlipList></CollapsibleContent>
      </Collapsible>
    </CollapsibleContent>
  </Collapsible>;
}
