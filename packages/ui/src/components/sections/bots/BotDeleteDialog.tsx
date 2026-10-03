import React from 'react';
import { deleteBot, type BotSummary } from '@/lib/bots';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function BotDeleteDialog({ bot, onClose, onAccepted }: {
  bot: BotSummary; onClose(): void; onAccepted(bot: BotSummary | null): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await deleteBot(bot.id);
      if (alive.current) { onAccepted(result); onClose(); }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (alive.current) setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('settings.bots.delete')} · {bot.name}</DialogTitle>
        <DialogDescription>{t('settings.bots.deleteDescription')}</DialogDescription>
      </DialogHeader>
      {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
        <Button variant="destructive" disabled={busy} onClick={() => { void remove(); }}>{t(busy ? 'settings.bots.deleting' : 'settings.bots.delete')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
