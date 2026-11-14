import React from 'react';
import { getRuntimeApiBaseUrl, runtimeFetch } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { buildPairingConnectionPayload, encodePairingConnectionPayload, type PairingEndpointCandidate } from '@/lib/connectionPayload';
import { SettingsPageLink } from '../shared/SettingsPageLink';

export function BrowserConnectorDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n(), { clientAuth } = useRuntimeAPIs();
  const initialAddress = React.useRef(getRuntimeApiBaseUrl() || window.location.origin);
  const [address, setAddress] = React.useState(initialAddress.current);
  const [name, setName] = React.useState('');
  const [link, setLink] = React.useState(''), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void clientAuth?.getPairingTransports().then(value => { if (active && value.lan) setAddress(current => current === initialAddress.current ? value.lan! : current); }, cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [clientAuth]);
  const download = async () => {
    setError(''); setBusy(true);
    try {
      const response = await runtimeFetch('/api/browser-resources/connector/download');
      if (!response.ok) throw new Error(t('settings.browser.downloadFailed'));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'varin-browser-connector.zip';
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const pair = async () => {
    if (!clientAuth || busy) return;
    setBusy(true); setError('');
    try {
      const result = await clientAuth.createPairingSession({ label: name.trim() || t('settings.browser.title'), allowedClientKinds: ['desktop'], serverUrl: address.trim(), includeRelay: false });
      setLink(encodePairingConnectionPayload(buildPairingConnectionPayload({ pairingId: result.pairing.id, secret: result.pairing.secret,
        label: result.server.label, fingerprint: result.pairing.fingerprint ?? undefined, expiresAt: result.pairing.expiresAt,
        candidates: result.server.candidates as PairingEndpointCandidate[] })));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-xl">
    <DialogHeader><DialogTitle>{t('settings.browser.connectExisting')}</DialogTitle><DialogDescription>{t('settings.browser.connectorHint')}</DialogDescription></DialogHeader>
    <div className="space-y-5">
      <div className="space-y-2"><p className="typography-ui-label">{t('settings.browser.installExtension')}</p><p className="typography-meta text-muted-foreground">{t('settings.browser.installHint')}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void download()}>{t('settings.browser.download')}</Button></div>
      <div className="space-y-3 border-t border-border/60 pt-5"><p className="typography-ui-label">{t('settings.browser.pairExtension')}</p>
        <label className="grid gap-2 typography-meta">{t('settings.browser.name')}<Input value={name} onChange={event => setName(event.target.value)} disabled={busy || !!link} /></label>
        <label className="grid gap-2 typography-meta">{t('settings.browser.hostAddress')}<Input value={address} onChange={event => setAddress(event.target.value)} disabled={busy || !!link} autoComplete="url" /><span className="text-muted-foreground">{t('settings.browser.hostAddressHint')}</span></label>
        {link ? <div className="flex gap-2"><Input value={link} readOnly aria-label={t('settings.browser.pairingLink')} className="min-w-0 flex-1" /><Button variant="outline" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true), cause => setError(String(cause)))}>{t(copied ? 'settings.browser.copied' : 'settings.browser.copyLink')}</Button></div>
          : <Button size="sm" disabled={busy || !clientAuth || !address.trim()} onClick={() => void pair()}>{t('settings.browser.createLink')}</Button>}
        <p className="typography-meta text-muted-foreground">{t('settings.browser.shareHint')}</p>
      </div>
      {error && <p role="alert" className="break-words typography-meta text-destructive">{error}</p>}
      <SettingsPageLink page="access" onNavigate={onClose}>{t('settings.browser.manageAccess')}</SettingsPageLink>
    </div>
    <DialogFooter><Button disabled={busy} onClick={onClose}>{t('bot.workspace.close')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
