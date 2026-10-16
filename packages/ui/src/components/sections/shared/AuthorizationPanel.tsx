import React from 'react';
import type { AuthorizationState } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';

export function AuthorizationPanel({ state, onReply, onCancel }: {
  state: AuthorizationState;
  onReply(value: string): Promise<void>;
  onCancel(): Promise<void>;
}) {
  const { t } = useI18n();
  const [redirect, setRedirect] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-lg border border-border p-3 typography-meta">
    <p>{t(`settings.authorization.${state.status}`)}</p>
    {state.message ? <p>{state.message}</p> : null}
    {state.status === 'pending' ? <>
      {state.authorizationUrl ? <a className="text-primary underline" href={state.authorizationUrl} target="_blank" rel="noreferrer">{t('settings.authorization.open')}</a> : null}
      {state.deviceCode ? <div className="space-y-2"><p className="text-muted-foreground">{t('settings.authorization.deviceCode')}</p><code className="block select-all rounded-md bg-muted px-4 py-3 text-lg tracking-widest">{state.deviceCode}</code></div> : null}
      <div className="flex gap-2">
        {!state.deviceCode ? <>
        <Input aria-label={t('settings.authorization.callback')} placeholder={t('settings.authorization.callback')} value={redirect} disabled={busy} onChange={event => setRedirect(event.target.value)} />
        <Button variant="outline" disabled={busy || !redirect.trim()} onClick={() => { void run(() => onReply(redirect)); }}>{t('settings.authorization.submit')}</Button>
        </> : null}
        <Button variant="ghost" disabled={busy} onClick={() => { void run(onCancel); }}>{t('settings.models.close')}</Button>
      </div>
    </> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}
