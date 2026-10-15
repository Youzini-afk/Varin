import React from 'react';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import { desktopHostsGet, desktopLocalClientTokenGet } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { checkLocalNativeRuntime } from './nativeRuntimeReadiness';

export function LocalRuntimeCard({ onContinue }: { onContinue: () => Promise<void> | void }) {
  const { t } = useI18n();
  const { threads } = useRuntimeAPIs();
  const [status, setStatus] = React.useState<'checking' | 'ready' | 'failed'>('checking');
  const [error, setError] = React.useState<string | null>(null);
  const [continuing, setContinuing] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    setStatus('checking');
    setError(null);
    void (async () => {
      if (isDesktopShell()) {
        const [config, token] = await Promise.all([desktopHostsGet(), desktopLocalClientTokenGet()]);
        await checkLocalNativeRuntime(config.localOrigin, token);
      } else {
        if (!threads) throw new Error('The native Thread API is unavailable.');
        await threads.list();
      }
    })().then(() => { if (!cancelled) setStatus('ready'); }, (reason: unknown) => {
      if (cancelled) return;
      setStatus('failed');
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [attempt, threads]);
  const proceed = async () => {
    setContinuing(true);
    try { await onContinue(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setContinuing(false); }
  };
  return <div className="app-region-no-drag space-y-4">
    <div role="status" aria-live="polite" className="rounded-xl border border-border bg-background/50 p-4">
      <p className="typography-ui-label font-medium">{t(`onboarding.native.${status}`)}</p>
      {error ? <p className="mt-2 break-words typography-meta text-destructive">{error}</p> : null}
    </div>
    <div className="flex gap-2">
      {status === 'ready' ? <Button data-native-local-runtime-continue="true" disabled={continuing} onClick={() => void proceed()}>{t('onboarding.native.continue')}</Button> : null}
      {status === 'failed' ? <>
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t('onboarding.native.retry')}</Button>
        {isDesktopShell() ? <Button onClick={() => void restartDesktopApp().catch((reason) => setError(String(reason)))}>{t('onboarding.native.restart')}</Button> : null}
      </> : null}
    </div>
  </div>;
}
