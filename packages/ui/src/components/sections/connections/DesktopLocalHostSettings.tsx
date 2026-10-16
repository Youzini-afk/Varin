import React from 'react';
import type { DesktopLocalHostMode } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { useI18n } from '@/lib/i18n';
import { getDesktopLocalHostMode, setDesktopLocalHostMode, restartDesktopWithoutUpdate } from '@/lib/desktopLocalHost';
import { requestSettingsNavigation } from '@/lib/settings/drafts';

function useLocalHostMode() {
  const [mode, setMode] = React.useState<DesktopLocalHostMode | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const live = React.useRef(true);
  React.useEffect(() => {
    live.current = true;
    let cancelled = false;
    void getDesktopLocalHostMode().then(value => { if (!cancelled) setMode(value); }, reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; live.current = false; };
  }, []);
  return { mode, setMode, error, setError, live };
}

function RestartConfirmation({ open, onClose, onConfirm, busy }: { open: boolean; onClose(): void; onConfirm(): void; busy: boolean }) {
  const { t } = useI18n();
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy}><DialogHeader>
      <DialogTitle>{t('settings.connections.localHost.restartTitle')}</DialogTitle>
      <DialogDescription>{t('settings.connections.localHost.restartWarning')}</DialogDescription>
    </DialogHeader><DialogFooter>
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
      <Button disabled={busy} onClick={event => { event.preventDefault(); onConfirm(); }}>{t('settings.connections.localHost.restart')}</Button>
    </DialogFooter></DialogContent>
  </Dialog>;
}

export function DesktopLocalHostSettings() {
  const { t } = useI18n();
  const { mode, setMode, error, setError, live } = useLocalHostMode();
  const [draft, setDraft] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const writing = React.useRef(false);
  const [confirm, setConfirm] = React.useState(false);
  const enabled = draft ?? mode?.enabled ?? true;
  const dirty = Boolean(mode && enabled !== mode.enabled);
  const save = async () => {
    if (!mode || writing.current) return false;
    writing.current = true; setBusy(true); setError(null);
    try {
      const value = await setDesktopLocalHostMode({ enabled });
      if (!live.current) return false;
      setMode(value); setDraft(null); return true;
    } catch (reason) { if (live.current) setError(String(reason)); return false; }
    finally { writing.current = false; if (live.current) setBusy(false); }
  };
  const restart = async () => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError(null);
    try { await restartDesktopWithoutUpdate(); }
    catch (reason) { if (live.current) { setError(String(reason)); setConfirm(false); } }
    finally { writing.current = false; if (live.current) setBusy(false); }
  };
  return <SettingsSection title={t('settings.connections.localHost.title')} description={t('settings.connections.localHost.description')}>
    {!mode ? <p role={error ? 'alert' : 'status'}>{error ?? t('common.loading')}</p> : <div className="space-y-3">
      <label className="flex items-center gap-3 typography-ui-label"><input type="checkbox" checked={enabled}
        disabled={busy || mode.environmentDisabled || (!mode.canDisable && enabled)} onChange={event => setDraft(event.target.checked)} />{t('settings.connections.localHost.enabled')}</label>
      <p className="typography-meta text-muted-foreground">{t(`settings.connections.localHost.runtime.${mode.runtime}`)}</p>
      <p className="typography-meta text-muted-foreground">{t(mode.effectiveEnabled ? 'settings.connections.localHost.nextLocal' : 'settings.connections.localHost.nextFrontend')}</p>
      <p className="typography-meta text-muted-foreground">{t('settings.connections.localHost.sshWarning')}</p>
      {mode.environmentDisabled ? <p role="status" className="typography-meta">{t('settings.connections.localHost.environmentDisabled')}</p> : !mode.canDisable ? <p role="status" className="typography-meta">{t('settings.connections.localHost.bundledRequired')}</p> : null}
      {mode.requiresRestart ? <div className="flex flex-wrap items-center gap-3"><p role="status" className="typography-meta">{t('settings.connections.localHost.restartRequired')}</p><Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => requestSettingsNavigation(() => setConfirm(true))}>{t('settings.connections.localHost.restart')}</Button></div> : null}
      <SettingsActionBar dirty={dirty} saving={busy} error={error} saveDisabled={mode.environmentDisabled} onSave={save} onCancel={() => { setDraft(null); setError(null); }} />
    </div>}
    <RestartConfirmation open={confirm} busy={busy} onClose={() => setConfirm(false)} onConfirm={() => void restart()} />
  </SettingsSection>;
}

/** Available in the bundled shell even when every remote Agent is unreachable. */
export function LocalHostRecovery() {
  const { t } = useI18n();
  const { mode, error, setError, live } = useLocalHostMode();
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const writing = React.useRef(false);
  const restore = async () => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError(null);
    try {
      await setDesktopLocalHostMode({ enabled: true, selectLocalOnRestart: true });
      if (live.current) await restartDesktopWithoutUpdate();
    } catch (reason) { if (live.current) { setError(String(reason)); setConfirm(false); } }
    finally { writing.current = false; if (live.current) setBusy(false); }
  };
  return <div className="app-region-no-drag space-y-3 rounded-lg border border-border p-4">
    <p className="typography-meta text-muted-foreground">{t('settings.connections.localHost.recoveryHint')}</p>
    {mode?.environmentDisabled || mode?.environmentRemoteTarget
      ? <p role="status" className="typography-meta">{t(mode.environmentDisabled ? 'settings.connections.localHost.environmentDisabled' : 'settings.connections.localHost.environmentRemote')}</p>
      : <Button variant="outline" disabled={!mode || busy} onClick={() => setConfirm(true)}>{t('settings.connections.localHost.restore')}</Button>}
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    <RestartConfirmation open={confirm} busy={busy} onClose={() => setConfirm(false)} onConfirm={() => void restore()} />
  </div>;
}
