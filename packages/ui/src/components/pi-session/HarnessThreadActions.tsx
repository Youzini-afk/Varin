import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { HarnessThreadResultHistory } from './HarnessThreadResultHistory';
import { harnessThreadSessionId, parseHarnessThreadMutation, projectHarnessThreadState, type HarnessThreadSnapshot } from './harnessThreadPresentation';

export function HarnessThreadActions({ entry, parentSessionId, onDeleted }: {
  entry: HarnessThreadSnapshot; parentSessionId: string; onDeleted(): void;
}) {
  const { t } = useI18n();
  const threads = useHarnessThreadState();
  const abort = usePiSessionStore((state) => state.abort);
  const [busy, setBusy] = React.useState(false);
  const [dialog, setDialog] = React.useState<'delete' | 'history' | null>(null);
  const sessionId = harnessThreadSessionId(entry);
  const state = projectHarnessThreadState(entry);
  const running = ['running', 'starting', 'waiting', 'stalled', 'looping'].includes(state);
  const mutate = async (action: 'archive' | 'restore' | 'convert' | 'delete' | 'stop') => {
    setBusy(true);
    try {
      if (action === 'stop') {
        if (sessionId) await abort(sessionId);
      } else {
        const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}${action === 'delete' ? '' : `/${action}`}`, {
          method: action === 'delete' ? 'DELETE' : 'POST',
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? body.error ?? t('harness.threads.actionFailed'));
        if (action !== 'delete') threads.merge(parseHarnessThreadMutation(body));
        if (action === 'restore' && body.restoreStatus !== undefined && body.restoreStatus !== 'restored') {
          throw new Error(body.message ?? body.error ?? t('harness.threads.restoreFailed'));
        }
        if (action === 'delete') onDeleted();
      }
      await threads.reload();
      setDialog(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="size-8 p-0" disabled={busy} aria-label={t('harness.threads.actions')}>
        <Icon name={busy ? 'loader-4' : 'more'} className={busy ? 'size-4 animate-spin' : 'size-4'} />
      </Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {running && sessionId && !entry.thread.deletion ? <DropdownMenuItem onSelect={() => void mutate('stop')}>{t('harness.threads.stop')}</DropdownMenuItem> : null}
        {entry.thread.kind === 'discussion' && entry.thread.lifecycle === 'active' && !entry.thread.deletion ? <DropdownMenuItem onSelect={() => void mutate('convert')}>{t('harness.threads.convert')}</DropdownMenuItem> : null}
        <DropdownMenuItem disabled={Boolean(entry.thread.deletion)} onSelect={() => setDialog('history')}>{t('harness.threads.history.open')}</DropdownMenuItem>
        <DropdownMenuItem disabled={Boolean(entry.thread.deletion)} onSelect={() => void mutate(entry.thread.lifecycle === 'archived' ? 'restore' : 'archive')}>
          {t(entry.thread.lifecycle === 'archived' ? 'harness.threads.restore' : 'harness.threads.archive')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog('delete')} className="text-destructive">{t('harness.threads.delete')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t(dialog === 'history' ? 'harness.threads.history.title' : 'harness.threads.delete')}</DialogTitle>
          {dialog === 'delete' ? <DialogDescription>{t('harness.threads.deleteConfirm')}</DialogDescription> : null}
        </DialogHeader>
        {dialog === 'history' ? <HarnessThreadResultHistory parentSessionId={parentSessionId} threadId={entry.thread.id} onReleased={threads.reload} /> : <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>{t('harness.blocks.cancel')}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void mutate('delete')}>{t('harness.threads.delete')}</Button>
        </DialogFooter>}
      </DialogContent>
    </Dialog>
  </>;
}
