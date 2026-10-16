import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { finishSettingsNavigation, getPendingSettingsNavigation, pendingSettingsDrafts, stayInSettings, subscribeSettingsNavigation } from '@/lib/settings/drafts';

export function SettingsDraftDialog() {
  const { t } = useI18n();
  const pending = React.useSyncExternalStore(subscribeSettingsNavigation, getPendingSettingsNavigation, getPendingSettingsNavigation);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [pending]);
  const states = pendingSettingsDrafts();
  const finish = async (save: boolean) => {
    setBusy(true); setFailed(false);
    try { if (!await finishSettingsNavigation(save)) setFailed(true); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <Dialog open={pending !== null} onOpenChange={open => { if (!open && !busy) stayInSettings(); }}>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{t('settings.draft.leaveTitle')}</DialogTitle><DialogDescription>{t('settings.draft.leaveDescription')}</DialogDescription></DialogHeader>
      {failed ? <p role="alert" className="typography-meta text-destructive">{t('settings.draft.saveUnconfirmed')}</p> : null}
      <DialogFooter className="flex-wrap">
        <Button variant="ghost" disabled={busy} onClick={stayInSettings}>{t('settings.draft.keepEditing')}</Button>
        <Button variant="outline" disabled={busy || states.some(state => state.saving)} onClick={() => { void finish(false); }}>{t('settings.draft.discard')}</Button>
        <Button disabled={busy || states.some(state => state.saving || (state.dirty && (state.saveDisabled || !state.onSave)))} onClick={() => { void finish(true); }}>{t('settings.draft.saveAndLeave')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
