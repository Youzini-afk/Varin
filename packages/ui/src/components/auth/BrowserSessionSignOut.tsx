import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeKey, runtimeFetch, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeIdentityMatches, type RuntimeIdentity } from './sessionAuthGateState';

type BrowserDevice = { id: string; label?: string };
const currentRuntime = (): RuntimeIdentity => ({ apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() });

/** Only the Host can identify the browser's HttpOnly device credential. */
export const BrowserSessionSignOut: React.FC = () => {
  const { t } = useI18n();
  const [session, setSession] = React.useState<{ device: BrowserDevice; runtime: RuntimeIdentity } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const generation = React.useRef(0);
  const signingOut = React.useRef(false);

  React.useEffect(() => {
    const load = async () => {
      const request = ++generation.current;
      const runtime = currentRuntime();
      setSession(null);
      setBusy(false);
      setFailed(false);
      signingOut.current = false;
      try {
        const response = await runtimeFetch('/auth/session', { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json() as { authenticated?: boolean; browserDevice?: BrowserDevice };
        if (generation.current !== request || !runtimeIdentityMatches(runtime, currentRuntime())) return;
        if (data.authenticated === true && typeof data.browserDevice?.id === 'string') {
          setSession({ device: data.browserDevice, runtime });
        }
      } catch {
        // Missing status is not authority to offer device revocation.
      }
    };
    void load();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => { void load(); });
    return () => { generation.current += 1; unsubscribe(); };
  }, []);

  const signOut = async () => {
    if (!session || signingOut.current || !runtimeIdentityMatches(session.runtime, currentRuntime())) return;
    const request = generation.current;
    signingOut.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const response = await runtimeFetch('/auth/browser-session', {
        method: 'DELETE', credentials: 'include', headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => null) as { signedOut?: boolean } | null;
      if (generation.current !== request || !runtimeIdentityMatches(session.runtime, currentRuntime())) return;
      if (!response.ok || data?.signedOut !== true) throw new Error('Browser sign-out was not confirmed');
      // Leave the authenticated app and its live connections. The auth gate will
      // now offer pairing (or the Host's explicit password login, if configured).
      window.location.reload();
    } catch {
      if (generation.current !== request || !runtimeIdentityMatches(session.runtime, currentRuntime())) return;
      signingOut.current = false;
      setBusy(false);
      setFailed(true);
    }
  };

  if (!session) return null;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="typography-meta font-medium">{t('sessionAuth.browser.currentDevice')}</span>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}>
          {busy ? t('sessionAuth.browser.signingOut') : t('sessionAuth.browser.signOut')}
        </Button>
      </div>
      {session.device.label && <p className="typography-meta text-muted-foreground">{session.device.label}</p>}
      <p className="typography-meta text-muted-foreground">{t('sessionAuth.browser.signOutDescription')}</p>
      {failed && <p role="alert" className="typography-meta text-destructive">{t('sessionAuth.browser.signOutFailed')}</p>}
    </div>
  );
};
