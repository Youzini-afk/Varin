import React from 'react';
import QRCode from 'qrcode';
import { getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged, type ExternalAccessSnapshot, type ExternalAccessFrpcComponent } from '@varin/application-client';
import { BrowserSessionSignOut } from '@/components/auth/BrowserSessionSignOut';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { SettingsPageLink } from '../shared/SettingsPageLink';
import { SettingsSection, SettingsFieldRow, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_SIZE } from '../shared/SettingsSection';

interface Draft {
  provider: 'reverse-proxy' | 'frp' | 'external-forwarding';
  serverAddress: string;
  serverPort: string;
  serverName: string;
  caFile: string;
  proxyName: string;
  remotePort: string;
  tokenEnv: string;
  name: string;
  publicOrigin: string;
  host: string;
  port: string;
}

const API = '/api/varin/external-access';
const DEPLOYMENT_KIT_URL = 'https://github.com/Astrmira/Varin/tree/main/deploy/external-access';
const defaultDraft = (): Draft => ({
  provider: 'reverse-proxy', name: '', publicOrigin: '', host: '127.0.0.1', port: '3100',
  serverAddress: '', serverPort: '7000', serverName: '', caFile: '', proxyName: 'varin', remotePort: '7300', tokenEnv: 'VARIN_FRP_TOKEN',
});
const toDraft = (snapshot: ExternalAccessSnapshot): Draft => snapshot.entry ? {
  ...defaultDraft(),
  provider: snapshot.entry.configuration.provider,
  ...(snapshot.entry.configuration.frp ? {
    serverAddress: snapshot.entry.configuration.frp.server.address,
    serverPort: String(snapshot.entry.configuration.frp.server.port),
    serverName: snapshot.entry.configuration.frp.server.tls.serverName,
    caFile: snapshot.entry.configuration.frp.server.tls.caFile,
    proxyName: snapshot.entry.configuration.frp.proxy.name,
    remotePort: String(snapshot.entry.configuration.frp.proxy.remotePort),
    tokenEnv: snapshot.entry.configuration.frp.tokenEnv,
  } : {}),
  name: snapshot.entry.configuration.name,
  publicOrigin: snapshot.entry.configuration.publicOrigin,
  host: snapshot.entry.configuration.backend.host,
  port: String(snapshot.entry.configuration.backend.port),
} : defaultDraft();
const settingsRevision = (snapshot: ExternalAccessSnapshot) => snapshot.entry?.revision ?? (snapshot.settingsRevision && snapshot.settingsRevision > 0 ? snapshot.settingsRevision : null);
const backendUrl = ({ host, port }: { host: string; port: number }) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
const phaseKeys: Record<ExternalAccessSnapshot['phase'], I18nKey> = {
  disabled: 'settings.varin.externalAccess.phase.disabled',
  enabled: 'settings.varin.externalAccess.phase.enabled',
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
  return <><BrowserSessionSignOut /><ExternalAccessPanel key={host} host={host} /></>;
}

function ExternalAccessPanel({ host }: { host: number }) {
  const { t, locale } = useI18n();
  const [snapshot, setSnapshot] = React.useState<ExternalAccessSnapshot | null>(null);
  const [draft, setDraft] = React.useState<Draft>(defaultDraft);
  const [draftRevision, setDraftRevision] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [needsRefresh, setNeedsRefresh] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = React.useState(false);
  const [deploymentOpen, setDeploymentOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [componentBusy, setComponentBusy] = React.useState(false);
  const mounted = React.useRef(false);
  const observedSnapshot = React.useRef<ExternalAccessSnapshot | null>(null);
  const pendingObservation = React.useRef(false);
  const inFlight = React.useRef(false);
  const current = React.useCallback(() => mounted.current && getRuntimeEndpointGeneration() === host, [host]);

  const accept = React.useCallback((next: ExternalAccessSnapshot, replaceDraft: boolean) => {
    observedSnapshot.current = next;
    setSnapshot(next);
    if (!next.entry) setRemoveOpen(false);
    if (!next.listener) setPairingOpen(false);
    if (replaceDraft) {
      setDraft(toDraft(next));
      setDraftRevision(settingsRevision(next));
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

  const reconcileStatus = React.useCallback(async () => {
    if (!current()) return;
    if (inFlight.current || !observedSnapshot.current) { pendingObservation.current = true; return; }
    inFlight.current = true; pendingObservation.current = false; setBusy(true);
    try {
      const next = await read();
      if (!current()) return;
      if (settingsRevision(next) !== settingsRevision(observedSnapshot.current)) setConflict(true);
      accept(next, false);
    } catch {
      if (current()) setError(t('settings.varin.externalAccess.loadUnavailable'));
    } finally {
      inFlight.current = false;
      if (current()) {
        setBusy(false);
        if (pendingObservation.current) void reconcileStatus();
      }
    }
  }, [accept, current, read, t]);

  React.useEffect(() => subscribeVarinEvents(event => {
    if (event.type === 'external-access-changed' || event.type === 'stream-ready') void reconcileStatus();
  }), [reconcileStatus]);

  React.useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void read().then(next => { if (!cancelled && current()) accept(next, true); }).catch(failure => {
      if (!cancelled && current()) setError(failure instanceof Error ? failure.message : t('settings.varin.externalAccess.loadUnavailable'));
    }).finally(() => { if (!cancelled && current()) { setBusy(false); if (pendingObservation.current) void reconcileStatus(); } });
    return () => { cancelled = true; mounted.current = false; };
  }, [accept, current, read, reconcileStatus, t]);

  const refresh = async () => {
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await read();
      if (!current()) return;
      // Refresh observes status without erasing an unsaved draft or silently
      // rebasing that draft onto another client's newly committed revision.
      if (snapshot && settingsRevision(next) !== settingsRevision(snapshot)) setConflict(true);
      accept(next, !snapshot);
      setNeedsRefresh(false);
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : t('settings.varin.externalAccess.loadUnavailable'));
    } finally {
      inFlight.current = false;
      if (current()) { setBusy(false); if (pendingObservation.current) void reconcileStatus(); }
    }
  };

  const environmentManaged = snapshot?.source === 'environment';
  const readOnly = environmentManaged || (snapshot?.entry?.configuration.provider === 'frp' && !snapshot.entry.configuration.frp);
  const dirty = snapshot !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(snapshot));
  const transition = snapshot?.phase === 'starting' || snapshot?.phase === 'reconnecting' || snapshot?.phase === 'stopping';
  const mutationBlocked = busy || componentBusy || !snapshot || environmentManaged || conflict || needsRefresh;

  const mutate = async (action: 'save' | 'enable' | 'disable' | 'retry' | 'remove') => {
    if (inFlight.current || mutationBlocked || !current() || (action === 'save' && readOnly) || (transition && action !== 'disable')) return;
    let configuration;
    if (action === 'save') {
      try {
        const origin = new URL(draft.publicOrigin.trim());
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
        const port = Number(draft.port);
        if (!/^\d+$/.test(draft.port) || !Number.isInteger(port) || port < 1 || port > 65535 || !draft.host.trim()) throw new Error();
        configuration = { name: draft.name.trim(), provider: draft.provider, publicOrigin: origin.origin,
          backend: { host: draft.host.trim(), port } };
        if (draft.provider === 'frp') {
          const serverPort = Number(draft.serverPort), remotePort = Number(draft.remotePort);
          if (!['127.0.0.1', '::1'].includes(draft.host.trim())
            || ![draft.serverPort, draft.remotePort].every(value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)
            || !draft.serverAddress.trim() || !draft.serverName.trim() || !draft.caFile.trim()
            || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(draft.proxyName.trim())
            || !/^VARIN_FRP_TOKEN(?:_[A-Z0-9_]+)?$/.test(draft.tokenEnv.trim())) {
            setError(t('settings.varin.externalAccess.frp.invalid')); return;
          }
          configuration = { ...configuration, frp: {
            server: { address: draft.serverAddress.trim(), port: serverPort, tls: { caFile: draft.caFile.trim(), serverName: draft.serverName.trim() } },
            proxy: { name: draft.proxyName.trim(), remotePort }, tokenEnv: draft.tokenEnv.trim(),
          } };
        }
      } catch {
        setError(t('settings.varin.externalAccess.invalidConfiguration'));
        return;
      }
    }
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await runtimeFetch(action === 'save' || action === 'remove' ? API : `${API}/${action}`, {
        method: action === 'save' ? 'PUT' : action === 'remove' ? 'DELETE' : 'POST',
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
        accept(next, action === 'save' || action === 'remove' || !dirty);
        // Disabling can cancel a reconnect while the user has an unsaved draft.
        // A successful CAS changed only enable intent, so retain that draft.
        if (action !== 'save' && action !== 'remove' && dirty) setDraftRevision(settingsRevision(next));
        if (action === 'save') setNotice(t('settings.varin.externalAccess.saved'));
        if (action === 'remove') { setRemoveOpen(false); setNotice(t('settings.varin.externalAccess.removed')); }
      }
    } catch {
      if (current()) {
        // Do not replay an effect whose response may have been lost.
        setNeedsRefresh(true);
        setError(t('settings.varin.externalAccess.outcomeUnknown'));
      }
    } finally {
      inFlight.current = false;
      if (current()) { setBusy(false); if (pendingObservation.current) void reconcileStatus(); }
    }
  };

  const checkAccess = async () => {
    if (inFlight.current || busy || !snapshot?.listener || transition || conflict || needsRefresh || !current()) return;
    inFlight.current = true;
    setBusy(true); setChecking(true); setError(null); setNotice(null); setDetailsOpen(true);
    try {
      const response = await runtimeFetch(`${API}/check`, { method: 'POST', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(response.status === 403
        ? t('settings.varin.externalAccess.ownerRequired') : t('settings.varin.externalAccess.checkFailed'));
      const next = await response.json() as ExternalAccessSnapshot;
      if (!current()) return;
      if (settingsRevision(next) !== settingsRevision(snapshot)) setConflict(true);
      accept(next, false);
    } catch (failure) {
      // A reachability check neither retries configuration changes nor stops forwarding.
      if (current()) setError(failure instanceof Error ? failure.message : t('settings.varin.externalAccess.checkFailed'));
    } finally {
      inFlight.current = false;
      if (current()) { setBusy(false); setChecking(false); if (pendingObservation.current) void reconcileStatus(); }
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
    <div className="min-w-0 space-y-4">
      <SettingsFieldRow label={t('settings.varin.externalAccess.currentHost')} description={t('settings.varin.externalAccess.hostScope')}>
        <span className="min-w-0 break-all typography-meta">{snapshot?.hostName || t('settings.varin.externalAccess.hostUnknown')}</span>
      </SettingsFieldRow>
      {busy && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.working')}</p>}
      {error && <p role="alert" className="break-words typography-meta text-[var(--status-error)]">{error}</p>}
      {notice && <p role="status" className={SETTINGS_HELPER_CLASS}>{notice}</p>}
      {snapshot && <>
        {(snapshot.entry || snapshot.source === 'environment') && <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`${SETTINGS_FIELD_LABEL_CLASS} min-w-0 break-all`}>{snapshot.entry?.configuration.name || t('settings.varin.externalAccess.unnamed')}</span>
            <span role="status" className={`typography-meta ${snapshot.phase === 'failed' ? 'text-[var(--status-error)]' : 'text-muted-foreground'}`}>
              {t(phaseKeys[snapshot.phase])}
            </span>
          </div>
          {publicOrigin && <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all typography-meta">{publicOrigin}</code>
            <Button size="sm" variant="ghost" onClick={() => void copy(publicOrigin)}>{t('settings.varin.externalAccess.copyAddress')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(publicOrigin)}>{t('settings.varin.externalAccess.open')}</Button>
          </div>}
          {['reverse-proxy', 'external-forwarding'].includes(snapshot.entry?.configuration.provider ?? '') && <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.externalManagedStatus')}</p>}
          {snapshot.error && <p role="alert" className="break-words typography-meta text-[var(--status-error)]">{snapshot.error}</p>}
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
            <Button size="sm" variant="outline" disabled={busy || !snapshot.listener || transition || conflict || needsRefresh}
              onClick={() => void checkAccess()}>{t(checking ? 'settings.varin.externalAccess.checking' : 'settings.varin.externalAccess.checkAccess')}</Button>
            <Button size="sm" variant="outline" disabled={busy || !snapshot.listener || conflict || needsRefresh}
              onClick={() => setPairingOpen(true)}>{t('settings.varin.externalAccess.addBrowser')}</Button>
          </div>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.disableHint')}</p>
          {!environmentManaged && snapshot.entry && <Button size="sm" variant="ghost" disabled={mutationBlocked || transition} onClick={() => setRemoveOpen(true)}>{t('settings.varin.externalAccess.remove')}</Button>}
          <SettingsPageLink page="access">{t('settings.varin.externalAccess.manageDevices')}</SettingsPageLink>
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
              setDraftRevision(settingsRevision(snapshot)); setConflict(false); setNotice(t('settings.varin.externalAccess.reviewDraft'));
            }}>{t('settings.varin.externalAccess.keepDraft')}</Button>}
          </div>
        </div>}

        {!readOnly && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void mutate('save'); }}>
          <div className="space-y-1.5">
            <label className={SETTINGS_FIELD_LABEL_CLASS} htmlFor={`${fieldId}-provider`}>{t('settings.varin.externalAccess.provider')}</label>
            <Select value={draft.provider} disabled={busy} onValueChange={value => setDraft(previous => ({ ...previous, provider: value as Draft['provider'] }))}>
              <SelectTrigger id={`${fieldId}-provider`} size={SETTINGS_SELECT_SIZE}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reverse-proxy">{t('settings.varin.externalAccess.reverseProxy')}</SelectItem>
                <SelectItem value="frp">{t('settings.varin.externalAccess.frp.label')}</SelectItem>
                <SelectItem value="external-forwarding">{t('settings.varin.externalAccess.externalManaged')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.provider === 'external-forwarding' && <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.externalManagedHint')}</p>}
          <div className="grid min-w-0 gap-3 @md:grid-cols-2">
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
          {draft.provider === 'frp' && <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.frp.label')}</legend>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.frp.operatorHint')}</p>
            <div className="grid gap-3 @md:grid-cols-2">
              {([
                ['serverAddress', 'serverAddress', 'text'], ['serverPort', 'serverPort', 'number'],
                ['serverName', 'serverName', 'text'], ['caFile', 'caFile', 'text'],
                ['proxyName', 'proxyName', 'text'], ['remotePort', 'remotePort', 'number'],
                ['tokenEnv', 'tokenEnv', 'text'],
              ] as const).map(([key, label, type]) => <div key={key} className="space-y-1.5">
                <label className={SETTINGS_FIELD_LABEL_CLASS} htmlFor={`${fieldId}-${key}`}>{t(`settings.varin.externalAccess.frp.${label}`)}</label>
                <Input id={`${fieldId}-${key}`} type={type} required value={draft[key]} disabled={busy}
                  {...(type === 'number' ? { min: 1, max: 65535, step: 1 } : {})}
                  autoComplete="off" spellCheck={false}
                  onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} />
              </div>)}
            </div>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.frp.secretHint')}</p>
            <FrpcComponentTools disabled={busy || !!transition} current={current} onBusyChange={setComponentBusy} />
          </fieldset>}
          {snapshot.entry?.enabled && dirty && <p role="status" className="typography-meta text-[var(--status-warning)]">{t('settings.varin.externalAccess.applyWarning')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={mutationBlocked || transition || (!dirty && !!snapshot.entry)}>{t('settings.varin.externalAccess.save')}</Button>
            {dirty && !conflict && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { accept(snapshot, true); setError(null); }}>
              {t('settings.varin.externalAccess.discard')}
            </Button>}
            {dirty && <span className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.unsaved')}</span>}
          </div>
        </form>}

        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger>{t('settings.varin.externalAccess.details')}</CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 px-2 pt-3">
            {detailsOpen && <>
            {snapshot.accessCheck && <div role="status" className="space-y-1 break-words">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{t(snapshot.accessCheck.state === 'verified' ? 'settings.varin.externalAccess.check.verified' : 'settings.varin.externalAccess.check.unverified')}</p>
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.check.time', { time: new Date(snapshot.accessCheck.checkedAt).toLocaleString(locale) })}</p>
              {snapshot.accessCheck.reason && <p className={SETTINGS_HELPER_CLASS}>{t(`settings.varin.externalAccess.check.${snapshot.accessCheck.reason}`)}</p>}
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.check.scope')}</p>
            </div>}
            <div className="space-y-1">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.actualListener')}</p>
              <p className="break-all font-mono typography-meta">{snapshot.listener ? backendUrl(snapshot.listener) : t('settings.varin.externalAccess.notListening')}</p>
            </div>
            {snapshot.entry && <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.configuredBackend', { address: backendUrl(snapshot.entry.configuration.backend) })}</p>}
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.proxyGuidance')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.bindGuidance')}</p>
            </>}
          </CollapsibleContent>
        </Collapsible>
      </>}
      <Button size="sm" variant="outline" onClick={() => setDeploymentOpen(true)}>{t('settings.varin.externalAccess.deploymentFiles')}</Button>
    </div>
    {removeOpen && snapshot?.entry && <Dialog open onOpenChange={open => { if (!open) setRemoveOpen(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('settings.varin.externalAccess.remove')}</DialogTitle>
          <DialogDescription>{t('settings.varin.externalAccess.removeHint')}</DialogDescription></DialogHeader>
        <p className="break-all font-mono typography-meta">{snapshot.entry.configuration.publicOrigin}</p>
        {error && <p role="alert" className="break-words typography-meta text-[var(--status-error)]">{error}</p>}
        {conflict && <p role="alert" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.conflict')}</p>}
        <Button variant="outline" disabled={mutationBlocked || transition} onClick={() => void mutate('remove')}>{t('settings.varin.externalAccess.confirmRemove')}</Button>
      </DialogContent>
    </Dialog>}
    {deploymentOpen && <DeploymentFilesDialog current={current} hostName={snapshot?.hostName} origin={publicOrigin}
      backend={snapshot?.listener ?? snapshot?.entry?.configuration.backend} onClose={() => setDeploymentOpen(false)} />}
    {pairingOpen && snapshot?.listener && <BrowserPairingDialog key={snapshot.listener.origin} host={host} origin={snapshot.listener.origin} pairingDefaults={snapshot.pairingDefaults} onClose={() => setPairingOpen(false)} />}
  </SettingsSection>;
}

function FrpcComponentTools({ disabled, current, onBusyChange }: { disabled: boolean; current(): boolean; onBusyChange(busy: boolean): void }) {
  const { t } = useI18n();
  const [component, setComponent] = React.useState<ExternalAccessFrpcComponent | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uncertain, setUncertain] = React.useState(false);
  const inFlight = React.useRef(false);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const inspect = async (install: boolean) => {
    if (inFlight.current || disabled || !current() || (install && (uncertain || !component?.installSupported))) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError(null);
    try {
      const response = await runtimeFetch(`${API}/component${install ? '/install' : ''}`, {
        method: install ? 'POST' : 'GET', headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        if (alive.current && current()) setError(response.status === 403 ? t('settings.varin.externalAccess.ownerRequired') : t('settings.varin.externalAccess.component.failed'));
        return;
      }
      const result = await response.json() as ExternalAccessFrpcComponent;
      if (alive.current && current()) { setComponent(result); setUncertain(false); }
    } catch (failure) {
      if (alive.current && current()) {
        setError(install ? t('settings.varin.externalAccess.component.unknown') : failure instanceof Error ? failure.message : t('settings.varin.externalAccess.component.failed'));
        if (install) setUncertain(true);
      }
    } finally { inFlight.current = false; if (current()) onBusyChange(false); if (alive.current && current()) setBusy(false); }
  };
  return <div className="space-y-2 border-t border-border pt-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => void inspect(false)}>{t('settings.varin.externalAccess.component.check')}</Button>
      {component && component.state !== 'available' && component.installSupported && <Button type="button" size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal text-left" disabled={disabled || busy || uncertain} onClick={() => void inspect(true)}>{t('settings.varin.externalAccess.component.install')}</Button>}
    </div>
    {busy && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.working')}</p>}
    {component && <div role="status" className="space-y-1 break-all">
      <p className={SETTINGS_HELPER_CLASS}>{t(`settings.varin.externalAccess.component.${component.state}`)}</p>
      <p className={SETTINGS_HELPER_CLASS}>{t(component.version ? 'settings.varin.externalAccess.component.version' : 'settings.varin.externalAccess.component.downloadVersion', { version: component.version ?? component.managedVersion })}</p>
      {component.source && <p className={SETTINGS_HELPER_CLASS}>{t(`settings.varin.externalAccess.component.source.${component.source}`)}</p>}
      {component.executablePath && <p className="font-mono typography-meta">{component.executablePath}</p>}
      {component.error && <p className={SETTINGS_HELPER_CLASS}>{component.error}</p>}
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.component.hint')}</p>
    </div>}
    {error && <p role="alert" className="break-words typography-meta text-[var(--status-error)]">{error}</p>}
  </div>;
}

function DeploymentFilesDialog({ hostName, origin, backend, onClose, current }: {
  current(): boolean; hostName?: string; origin?: string; backend?: { host: string; port: number }; onClose(): void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Explicit allowlist. Never serialize the snapshot, FRP settings, pairing data or credentials.
  const handoff = [
    ...(hostName ? [`Host: ${hostName}`] : []),
    ...(origin ? [`Public HTTPS origin: ${origin}`] : []),
    ...(backend ? [`Host backend listener: ${backendUrl(backend)}`] : []),
    `Deployment files: ${DEPLOYMENT_KIT_URL}`,
  ].join('\n');
  const copyHandoff = async () => {
    setError(null);
    try { await navigator.clipboard.writeText(handoff); if (alive.current && current()) setCopied(true); }
    catch { if (alive.current && current()) setError(t('settings.varin.externalAccess.copyFailed')); }
  };
  const getFile = async (kind: 'archive' | 'caddy' | 'nginx') => {
    if (inFlight.current || !current()) return;
    inFlight.current = true; setBusy(true); setError(null); setCopied(false);
    try {
      const path = kind === 'archive' ? '/downloads/varin-external-access.tar.gz'
        : `/downloads/varin-external-access/snippets/${kind === 'caddy' ? 'Caddyfile' : 'nginx.conf'}`;
      const response = await runtimeFetch(path);
      if (!response.ok || response.headers.get('Content-Type')?.includes('text/html')) throw new Error();
      if (kind === 'archive') {
        const bytes = await response.arrayBuffer();
        const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
        if (header[0] !== 0x1f || header[1] !== 0x8b) throw new Error();
        if (!alive.current || !current()) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'varin-external-access.tar.gz';
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const text = await response.text();
        if (!text.trim() || /^\s*</.test(text)) throw new Error();
        if (!alive.current || !current()) return;
        await navigator.clipboard.writeText(text);
        if (alive.current && current()) setCopied(true);
      }
    } catch {
      if (alive.current && current()) setError(t('settings.varin.externalAccess.deployment.fileFailed'));
    } finally { inFlight.current = false; if (alive.current && current()) setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('settings.varin.externalAccess.deploymentFiles')}</DialogTitle>
        <DialogDescription>{t('settings.varin.externalAccess.deployment.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void openExternalUrl(`${DEPLOYMENT_KIT_URL}#readme`)}>{t('settings.varin.externalAccess.deployment.fullKit')}</Button>
        <Button size="sm" variant="outline" onClick={() => void openExternalUrl(`${DEPLOYMENT_KIT_URL}/snippets/Caddyfile`)}>{t('settings.varin.externalAccess.deployment.caddy')}</Button>
        <Button size="sm" variant="outline" onClick={() => void openExternalUrl(`${DEPLOYMENT_KIT_URL}/snippets/nginx.conf`)}>{t('settings.varin.externalAccess.deployment.nginx')}</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void getFile('archive')}>{t('settings.varin.externalAccess.deployment.download')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void getFile('caddy')}>{t('settings.varin.externalAccess.deployment.copyCaddy')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void getFile('nginx')}>{t('settings.varin.externalAccess.deployment.copyNginx')}</Button>
      </div>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.deployment.scope')}</p>
      <pre className="min-w-0 whitespace-pre-wrap break-all rounded-lg border border-border p-3 typography-meta">{handoff}</pre>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.deployment.safeCopy')}</p>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.deployment.legacyMigration')}</p>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.bindGuidance')}</p>
      <Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal" onClick={() => void copyHandoff()}>{t('settings.varin.externalAccess.deployment.copyForAgent')}</Button>
      {copied && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.varin.externalAccess.copied')}</p>}
      {error && <p role="alert" className="break-words typography-meta text-[var(--status-error)]">{error}</p>}
    </DialogContent>
  </Dialog>;
}

function BrowserPairingDialog({ host, origin, pairingDefaults, onClose }: { host: number; origin: string; pairingDefaults?: ExternalAccessSnapshot['pairingDefaults']; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [access, setAccess] = React.useState('persistent');
  const defaults = React.useRef(pairingDefaults ?? { linkTtlMs: 30 * 60_000, temporaryAccessTtlMs: 8 * 3_600_000 }).current;
  const [accessTtlMs, setAccessTtlMs] = React.useState(String(defaults.temporaryAccessTtlMs));
  const [linkTtlMs, setLinkTtlMs] = React.useState(String(defaults.linkTtlMs));
  const accessOptions = [...new Set([defaults.temporaryAccessTtlMs, 3_600_000, 28_800_000, 86_400_000, 604_800_000])];
  const linkOptions = [...new Set([defaults.linkTtlMs, 180_000, 1_800_000, 7_200_000, 86_400_000])];
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
      const issuedAt = Date.now();
      const clientExpiresAt = access === 'persistent' ? null : new Date(issuedAt + Number(accessTtlMs)).toISOString();
      const response = await runtimeFetch('/api/client-auth/pairing/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ allowedClientKinds: ['browser'], clientExpiresAt,
          expiresAt: new Date(issuedAt + Number(linkTtlMs)).toISOString() }),
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
          <Select value={accessTtlMs} onValueChange={value => { if (value) setAccessTtlMs(value); }} disabled={busy || uncertain}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} aria-label={t('settings.varin.externalAccess.pairing.duration')}><SelectValue /></SelectTrigger>
            <SelectContent>{accessOptions.map(value => {
              const duration = t('settings.varin.externalAccess.pairing.hours', { hours: Math.round(value / 3_600_000 * 100) / 100 });
              return <SelectItem key={value} value={String(value)}>{value === defaults.temporaryAccessTtlMs ? t('settings.varin.externalAccess.pairing.hostDefault', { duration }) : duration}</SelectItem>;
            })}</SelectContent>
          </Select>
        </div>}
        <div className="space-y-1.5">
          <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.varin.externalAccess.pairing.linkLifetime')}</p>
          <Select value={linkTtlMs} onValueChange={value => { if (value) setLinkTtlMs(value); }} disabled={busy || uncertain}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} aria-label={t('settings.varin.externalAccess.pairing.linkLifetime')}><SelectValue /></SelectTrigger>
            <SelectContent>{linkOptions.map(value => {
              const duration = t('settings.varin.externalAccess.pairing.minutes', { minutes: Math.round(value / 60_000 * 100) / 100 });
              return <SelectItem key={value} value={String(value)}>{value === defaults.linkTtlMs ? t('settings.varin.externalAccess.pairing.hostDefault', { duration }) : duration}</SelectItem>;
            })}</SelectContent>
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
      {error && <p role="alert" className="break-words typography-meta text-[var(--status-error)]">{error}</p>}
    </DialogContent>
  </Dialog>;
}
