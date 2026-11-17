import React from 'react';
import QRCode from 'qrcode';
import { getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged, type ExternalAccessSnapshot } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { SettingsSection, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_SIZE } from '../shared/SettingsSection';

interface Draft {
  name: string;
  publicOrigin: string;
  host: string;
  port: string;
}

const API = '/api/varin/external-access';
const defaultDraft = (): Draft => ({ name: '', publicOrigin: '', host: '127.0.0.1', port: '3100' });
const toDraft = (snapshot: ExternalAccessSnapshot): Draft => snapshot.entry ? {
  name: snapshot.entry.configuration.name,
  publicOrigin: snapshot.entry.configuration.publicOrigin,
  host: snapshot.entry.configuration.backend.host,
  port: String(snapshot.entry.configuration.backend.port),
} : defaultDraft();
const backendUrl = ({ host, port }: { host: string; port: number }) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
const phaseKeys: Record<ExternalAccessSnapshot['phase'], I18nKey> = {
  disabled: 'settings.varin.externalAccess.phase.disabled',
  starting: 'settings.varin.externalAccess.phase.starting',
  unverified: 'settings.varin.externalAccess.phase.unverified',
  reconnecting: 'settings.varin.externalAccess.phase.reconnecting',
  stopping: 'settings.varin.externalAccess.phase.stopping',
  failed: 'settings.varin.externalAccess.phase.failed',
  connected: 'settings.varin.externalAccess.phase.connected',
};

// A Host switch remounts all drafts and pairing secrets; late responses are also
// checked against the captured endpoint generation before they can affect UI.
export function ExternalAccessSettings() {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ExternalAccessPanel key={host} host={host} />;
}

function ExternalAccessPanel({ host }: { host: number }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<ExternalAccessSnapshot | null>(null);
  const [draft, setDraft] = React.useState<Draft>(defaultDraft);
  const [draftRevision, setDraftRevision] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [needsRefresh, setNeedsRefresh] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = React.useState(false);
  const mounted = React.useRef(false);
  const inFlight = React.useRef(false);
  const current = React.useCallback(() => mounted.current && getRuntimeEndpointGeneration() === host, [host]);

  const accept = React.useCallback((next: ExternalAccessSnapshot, replaceDraft: boolean) => {
    setSnapshot(next);
    if (replaceDraft) {
      setDraft(toDraft(next));
      setDraftRevision(next.entry?.revision ?? null);
      setConflict(false);
    }
  }, []);

  const read = React.useCallback(async (): Promise<ExternalAccessSnapshot> => {
    const response = await runtimeFetch(API, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(response.status === 403
      ? t('settings.varin.externalAccess.ownerRequired')
      : t('settings.varin.externalAccess.loadFailed', { status: response.status }));
    return await response.json() as ExternalAccessSnapshot;
  }, [t]);

  React.useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void read().then(next => { if (!cancelled && current()) accept(next, true); }).catch(failure => {
      if (!cancelled && current()) setError(failure instanceof Error ? failure.message : t('settings.varin.externalAccess.loadUnavailable'));
    }).finally(() => { if (!cancelled && current()) setBusy(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [accept, current, read, t]);

  const refresh = async () => {
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await read();
      if (!current()) return;
      // Refresh observes status without erasing an unsaved draft or silently
      // rebasing that draft onto another client's newly committed revision.
      if (snapshot && next.entry?.revision !== snapshot.entry?.revision) setConflict(true);
      accept(next, !snapshot);
      setNeedsRefresh(false);
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : t('settings.varin.externalAccess.loadUnavailable'));
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  };

  const environmentManaged = snapshot?.source === 'environment';
  const readOnly = environmentManaged || snapshot?.entry?.configuration.provider === 'frp';
  const dirty = snapshot !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(snapshot));
  const transition = snapshot?.phase === 'starting' || snapshot?.phase === 'reconnecting' || snapshot?.phase === 'stopping';
  const mutationBlocked = busy || !snapshot || environmentManaged || conflict || needsRefresh;

  const mutate = async (action: 'save' | 'enable' | 'disable' | 'retry') => {
    if (inFlight.current || mutationBlocked || !current() || (action === 'save' && readOnly) || (transition && action !== 'disable')) return;
    let configuration;
    if (action === 'save') {
      try {
        const origin = new URL(draft.publicOrigin.trim());
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
        const port = Number(draft.port);
        if (!/^\d+$/.test(draft.port) || !Number.isInteger(port) || port < 1 || port > 65535 || !draft.host.trim()) throw new Error();
        configuration = { name: draft.name.trim(), provider: 'reverse-proxy', publicOrigin: origin.origin,
          backend: { host: draft.host.trim(), port } };
      } catch {
        setError(t('settings.varin.externalAccess.invalidConfiguration'));
        return;
      }
    }
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await runtimeFetch(action === 'save' ? API : `${API}/${action}`, {
        method: action === 'save' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(action === 'save' ? { expectedRevision: draftRevision, configuration }
          : { expectedRevision: snapshot!.entry!.revision }),
      });
      if (!current()) return;
      if (response.status === 409) {
        setConflict(true);
        try { const latest = await read(); if (current()) accept(latest, false); }
        catch { if (current()) setNeedsRefresh(true); }
        return;
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        if (current()) setError(response.status === 403 ? t('settings.varin.externalAccess.ownerRequired')
          : failure?.error || t('settings.varin.externalAccess.actionFailed', { status: response.status }));
        return;
      }
      const next = await response.json() as ExternalAccessSnapshot;
      if (current()) {
        accept(next, action === 'save' || !dirty);
        // Disabling can cancel a reconnect while the user has an unsaved draft.
        // A successful CAS changed only enable intent, so retain that draft.
        if (action !== 'save' && dirty) setDraftRevision(next.entry?.revision ?? null);
        if (action === 'save') setNotice(t('settings.varin.externalAccess.saved'));
      }
    } catch {
      if (current()) {
        // Do not replay an effect whose response may have been lost.
        setNeedsRefresh(true);
        setError(t('settings.varin.externalAccess.outcomeUnknown'));
      }
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (current()) setNotice(t('settings.varin.externalAccess.copied'));
    } catch { if (current()) setError(t('settings.varin.externalAccess.copyFailed')); }
  };
  const publicOrigin = snapshot?.listener?.origin ?? snapshot?.entry?.configuration.publicOrigin;
  const fieldId = React.useId();
  return <SettingsSection title={t('settings.varin.externalAccess.title')} divider={false}
    description={t('settings.varin.externalAccess.description')}
    headerAction={<Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('settings.varin.externalAccess.refresh')}</Button>}>
    <div className="space-y-4">
      {busy && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.working')}</p>}
      {error && <p role="alert" className="typography-meta text-[var(--status-error)]">{error}</p>}
      {notice && <p role="status" className={SETTINGS_HELPER_CLASS}>{notice}</p>}
      {snapshot && <>
        {(snapshot.entry || snapshot.source === 'environment') && <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={SETTINGS_FIELD_LABEL_CLASS}>{snapshot.entry?.configuration.name || t('settings.varin.externalAccess.unnamed')}</span>
            <span role="status" className={`typography-meta ${snapshot.phase === 'failed' ? 'text-[var(--status-error)]' : 'text-muted-foreground'}`}>
              {t(phaseKeys[snapshot.phase])}
            </span>
          </div>
          {publicOrigin && <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all typography-meta">{publicOrigin}</code>
            <Button size="sm" variant="ghost" onClick={() => void copy(publicOrigin)}>{t('settings.varin.externalAccess.copyAddress')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(publicOrigin)}>{t('settings.varin.externalAccess.open')}</Button>
          </div>}
          {snapshot.error && <p role="alert" className="typography-meta text-[var(--status-error)]">{snapshot.error}</p>}
          {snapshot.phase === 'unverified' && <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.unverifiedHint')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {!environmentManaged && snapshot.entry && <Button size="sm" variant="outline"
              disabled={mutationBlocked || (snapshot.entry.enabled ? snapshot.phase === 'stopping' : transition || dirty)}
              onClick={() => void mutate(snapshot.entry!.enabled ? 'disable' : 'enable')}>
              {t(snapshot.entry.enabled ? 'settings.varin.externalAccess.disable' : 'settings.varin.externalAccess.enable')}
            </Button>}
            {!environmentManaged && snapshot.phase === 'failed' && <Button size="sm" variant="outline" disabled={mutationBlocked || dirty} onClick={() => void mutate('retry')}>
              {t('settings.varin.externalAccess.retry')}
            </Button>}
            <Button size="sm" variant="outline" disabled={busy || !snapshot.listener || conflict || needsRefresh}
              onClick={() => setPairingOpen(true)}>{t('settings.varin.externalAccess.addBrowser')}</Button>
          </div>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.disableHint')}</p>
        </div>}

        {readOnly && <p role="status" className={SETTINGS_HELPER_CLASS}>
          {t(snapshot.source === 'environment' ? 'settings.varin.externalAccess.environmentManaged' : 'settings.varin.externalAccess.frpManaged')}
        </p>}
        {conflict && <div role="alert" className="space-y-2 rounded-lg border border-[var(--status-warning-border)] p-3">
          <p className="typography-meta">{t('settings.varin.externalAccess.conflict')}</p>
          {snapshot.entry && <p className="break-all font-mono typography-meta">{snapshot.entry.configuration.publicOrigin} · {backendUrl(snapshot.entry.configuration.backend)}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || needsRefresh} onClick={() => { accept(snapshot, true); setError(null); }}>
              {t('settings.varin.externalAccess.useLatest')}
            </Button>
            {!readOnly && <Button size="sm" variant="outline" disabled={busy || needsRefresh} onClick={() => {
              setDraftRevision(snapshot.entry?.revision ?? null); setConflict(false); setNotice(t('settings.varin.externalAccess.reviewDraft'));
            }}>{t('settings.varin.externalAccess.keepDraft')}</Button>}
          </div>
        </div>}

        {!readOnly && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void mutate('save'); }}>
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1.5">
              <label className={SETTINGS_FIELD_LABEL_CLASS} htmlFor={`${fieldId}-origin`}>{t('settings.varin.externalAccess.publicOrigin')}</label>
              <Input id={`${fieldId}-origin`} type="url" required placeholder="https://varin.example.com" value={draft.publicOrigin} disabled={busy}
                onChange={event => setDraft(value => ({ ...value, publicOrigin: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className={SETTINGS_FIELD_LABEL_CLASS} htmlFor={`${fieldId}-name`}>{t('settings.varin.externalAccess.name')}</label>
              <Input id={`${fieldId}-name`} value={draft.name} disabled={busy} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className={SETTINGS_FIELD_LABEL_CLASS} htmlFor={`${fieldId}-host`}>{t('settings.varin.externalAccess.backendHost')}</label>
              <Input id={`${fieldId}-host`} required value={draft.host} disabled={busy} onChange={event => setDraft(value => ({ ...value, host: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className={SETTINGS_FIELD_LABEL_CLASS} htmlFor={`${fieldId}-port`}>{t('settings.varin.externalAccess.backendPort')}</label>
              <Input id={`${fieldId}-port`} type="number" min="1" max="65535" step="1" required value={draft.port} disabled={busy}
                onChange={event => setDraft(value => ({ ...value, port: event.target.value }))} />
            </div>
          </div>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.hostScope')}</p>
          {snapshot.entry?.enabled && dirty && <p role="status" className="typography-meta text-[var(--status-warning)]">{t('settings.varin.externalAccess.applyWarning')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={mutationBlocked || transition || (!dirty && !!snapshot.entry)}>{t('settings.varin.externalAccess.save')}</Button>
            {dirty && !conflict && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { accept(snapshot, true); setError(null); }}>
              {t('settings.varin.externalAccess.discard')}
            </Button>}
            {dirty && <span className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.unsaved')}</span>}
          </div>
        </form>}

        <Collapsible>
          <CollapsibleTrigger>{t('settings.varin.externalAccess.details')}</CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 px-2 pt-3">
            <div className="space-y-1">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.actualListener')}</p>
              <p className="break-all font-mono typography-meta">{snapshot.listener ? backendUrl(snapshot.listener) : t('settings.varin.externalAccess.notListening')}</p>
            </div>
            {snapshot.entry && <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.configuredBackend', { address: backendUrl(snapshot.entry.configuration.backend) })}</p>}
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.proxyGuidance')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.bindGuidance')}</p>
          </CollapsibleContent>
        </Collapsible>
      </>}
    </div>
    {pairingOpen && snapshot?.listener && <BrowserPairingDialog host={host} origin={snapshot.listener.origin} onClose={() => setPairingOpen(false)} />}
  </SettingsSection>;
}

function BrowserPairingDialog({ host, origin, onClose }: { host: number; origin: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [access, setAccess] = React.useState('persistent');
  const [hours, setHours] = React.useState('8');
  const [minutes, setMinutes] = React.useState('30');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [link, setLink] = React.useState<{ url: string; expiresAt: string; clientExpiresAt: string | null } | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [uncertain, setUncertain] = React.useState(false);
  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  const current = () => alive.current && getRuntimeEndpointGeneration() === host;
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    if (!link) return;
    let cancelled = false;
    void QRCode.toDataURL(link.url, { width: 240, margin: 2 }).then(value => { if (!cancelled) setQr(value); }).catch(() => {});
    const timer = setTimeout(() => { setExpired(true); setQr(null); }, Math.max(0, Date.parse(link.expiresAt) - Date.now()));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [link]);
  const issue = async () => {
    if (inFlight.current || uncertain || link || !current()) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const clientExpiresAt = access === 'persistent' ? null : new Date(Date.now() + Number(hours) * 3_600_000).toISOString();
      const response = await runtimeFetch('/api/client-auth/pairing/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ allowedClientKinds: ['browser'], clientExpiresAt,
          expiresAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString() }),
      });
      if (!current()) return;
      if (!response.ok) { setError(t('settings.varin.externalAccess.pairing.failed')); return; }
      const payload = await response.json() as { browserUrl?: string; pairing?: { expiresAt?: string; clientExpiresAt?: string | null } };
      const url = new URL(payload.browserUrl ?? '');
      if (url.origin !== origin || url.protocol !== 'https:' || !payload.pairing?.expiresAt || !Number.isFinite(Date.parse(payload.pairing.expiresAt))) throw new Error();
      if (current()) setLink({ url: url.href, expiresAt: payload.pairing.expiresAt, clientExpiresAt: payload.pairing.clientExpiresAt ?? clientExpiresAt });
    } catch {
      if (current()) { setUncertain(true); setError(t('settings.varin.externalAccess.pairing.unknown')); }
    } finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const copyLink = async () => {
    if (!link || expired) return;
    try { await navigator.clipboard.writeText(link.url); if (current()) setCopied(true); }
    catch { if (current()) setError(t('settings.varin.externalAccess.copyFailed')); }
  };
  const formatExpiry = (value: string) => new Date(value).toLocaleString(locale);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{t('settings.varin.externalAccess.addBrowser')}</DialogTitle>
        <DialogDescription>{t('settings.varin.externalAccess.pairing.description')}</DialogDescription>
      </DialogHeader>
      <p className="break-all font-mono typography-meta">{origin}</p>
      {!link && <div className="space-y-3">
        <div className="space-y-1.5">
          <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.pairing.access')}</p>
          <Select value={access} onValueChange={value => { if (value) setAccess(value); }} disabled={busy || uncertain}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} aria-label={t('settings.varin.externalAccess.pairing.access')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="persistent">{t('settings.varin.externalAccess.pairing.persistent')}</SelectItem>
              <SelectItem value="temporary">{t('settings.varin.externalAccess.pairing.temporary')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {access === 'temporary' && <div className="space-y-1.5">
          <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.pairing.duration')}</p>
          <Select value={hours} onValueChange={value => { if (value) setHours(value); }} disabled={busy || uncertain}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} aria-label={t('settings.varin.externalAccess.pairing.duration')}><SelectValue /></SelectTrigger>
            <SelectContent>{['1', '8', '24', '168'].map(value => <SelectItem key={value} value={value}>{t('settings.varin.externalAccess.pairing.hours', { hours: value })}</SelectItem>)}</SelectContent>
          </Select>
        </div>}
        <div className="space-y-1.5">
          <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.pairing.linkLifetime')}</p>
          <Select value={minutes} onValueChange={value => { if (value) setMinutes(value); }} disabled={busy || uncertain}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} aria-label={t('settings.varin.externalAccess.pairing.linkLifetime')}><SelectValue /></SelectTrigger>
            <SelectContent>{['3', '30', '120', '1440'].map(value => <SelectItem key={value} value={value}>{t('settings.varin.externalAccess.pairing.minutes', { minutes: value })}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button size="sm" disabled={busy || uncertain} onClick={() => void issue()}>{t('settings.varin.externalAccess.pairing.create')}</Button>
      </div>}
      {link && <div className="space-y-3">
        {expired ? <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.pairing.expired')}</p> : <>
          {qr && <img src={qr} alt={t('settings.varin.externalAccess.pairing.qrAlt')} width={240} height={240} className="mx-auto rounded-lg" />}
          <Input readOnly value={link.url} aria-label={t('settings.varin.externalAccess.pairing.link')} onFocus={event => event.target.select()} />
          <Button size="sm" variant="outline" onClick={() => void copyLink()}>{t(copied ? 'settings.varin.externalAccess.copied' : 'settings.varin.externalAccess.pairing.copy')}</Button>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.pairing.expires', { time: formatExpiry(link.expiresAt) })}</p>
        </>}
        <p className={SETTINGS_HELPER_CLASS}>{link.clientExpiresAt
          ? t('settings.varin.externalAccess.pairing.accessExpires', { time: formatExpiry(link.clientExpiresAt) })
          : t('settings.varin.externalAccess.pairing.persistentHint')}</p>
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.pairing.closeHint')}</p>
      </div>}
      {busy && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.working')}</p>}
      {error && <p role="alert" className="typography-meta text-[var(--status-error)]">{error}</p>}
    </DialogContent>
  </Dialog>;
}
