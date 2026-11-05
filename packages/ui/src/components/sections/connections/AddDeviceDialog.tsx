import React from 'react';
import { createHostConnectionsHttpAPI, type ThreadSourceTargets } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { createDesktopSshInstance } from '@/lib/desktopSsh';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { listComputers, type ComputerCatalog } from '@/lib/computers';

/** The consuming Host owns probing, credentials and SSH. No frontend-local reachability inference. */
export function AddDeviceDialog({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const { t } = useI18n(), { threads } = useRuntimeAPIs();
  const api = React.useMemo(createHostConnectionsHttpAPI, []);
  const [step, setStep] = React.useState<'method' | 'connection' | 'result'>('method');
  const [method, setMethod] = React.useState<'url' | 'ssh'>('url');
  const [name, setName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [token, setToken] = React.useState('');
  const [savedId, setSavedId] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [sources, setSources] = React.useState<ThreadSourceTargets>();
  const [computers, setComputers] = React.useState<ComputerCatalog>();
  const [status, setStatus] = React.useState<string>();
  const [imports, setImports] = React.useState<Awaited<ReturnType<typeof api.ssh.imports>>>([]);
  const [id] = React.useState(() => `device-${crypto.randomUUID()}`);
  React.useEffect(() => { void api.ssh.imports().then(setImports, () => {}); }, [api]);
  const inspect = React.useCallback(async () => {
    const [files, desktops] = await Promise.allSettled([threads?.sources.list(null), listComputers()]);
    api.assertOwner();
    if (files.status === 'fulfilled') setSources(files.value);
    if (desktops.status === 'fulfilled') setComputers(desktops.value);
    const failures = [files, desktops].flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
    setError(failures.length ? failures.join('\n') : undefined);
    onChanged();
  }, [api, threads, onChanged]);
  React.useEffect(() => savedId ? subscribeVarinEvents(event => {
    if (event.type !== 'ssh-instance-status') return;
    const state = event.status as { id?: string; phase?: string; detail?: string };
    if (state.id !== savedId) return;
    setStatus([state.phase, state.detail].filter(Boolean).join(' · '));
    if (state.phase === 'ready' || state.phase === 'error') void inspect().catch(error => setError(String(error)));
  }) : undefined, [savedId, inspect]);
  const connect = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      if (!savedId) {
        if (method === 'url') {
          const url = new URL(address.trim());
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(t('desktopHostSwitcher.error.invalidUrl'));
          const config = await api.hosts.get();
          const host = { id, label: name.trim() || url.host, url: url.href, apiUrl: url.href, ...(token.trim() ? { clientToken: token.trim() } : {}) };
          const probe = await api.hosts.probe(host);
          if (probe.status !== 'ok') throw new Error(t(`bot.workspace.connection.${probe.status}`));
          await api.hosts.set({ ...config, hosts: [...config.hosts, host] });
        } else {
          const config = await api.ssh.get();
          const instance = { ...createDesktopSshInstance(id, address.trim()), nickname: name.trim() || address.trim() };
          await api.ssh.set({ instances: [...config.instances, instance] });
        }
        setSavedId(id);
      }
      setStep('result');
      if (method === 'ssh') { await api.ssh.connect(id); const states = await api.ssh.status(); const state = states.find(state => state.id === id); setStatus(state ? [state.phase, state.detail].filter(Boolean).join(' · ') : undefined); }
      await inspect();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    if (method === 'ssh' && !target) { await connect(); return; }
    setBusy(true);
    try { await inspect(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const target = sources?.targets.find(target => target.resourceOwner.kind === 'managed_host' && target.resourceOwner.connectionId === savedId);
  const unavailable = sources?.unavailable.find(item => item.connectionId === savedId);
  const desktops = savedId ? computers?.desktops.filter(desktop => desktop.remote?.connectionId === savedId) ?? [] : [];
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-xl">
    <DialogHeader><DialogTitle>{t('bot.workspace.addDevice')}</DialogTitle><DialogDescription>{t('bot.workspace.deviceHint')}</DialogDescription></DialogHeader>
    <div className="device-connection-steps" aria-label={t('bot.workspace.addDevice')}>{(['method', 'connection', 'result'] as const).map((item, i) => <span key={item} aria-current={step === item ? 'step' : undefined}>{i + 1} · {t(`bot.workspace.connection.${item}`)}</span>)}</div>
    <div key={step} className="device-connection-step">
      {step === 'method' ? <div className="grid gap-3">{(['url', 'ssh'] as const).map(item => <button key={item} type="button" aria-pressed={method === item} className="device-connection-method" onClick={() => { setMethod(item); setAddress(''); }}><Icon name={item === 'ssh' ? 'terminal-box' : 'global'} className="size-5" /><span><b>{t(`bot.workspace.connection.${item}`)}</b><small>{t(`bot.workspace.connection.${item}Hint`)}</small></span><Icon name={method === item ? 'checkbox-circle' : 'arrow-right-s'} className="size-4" /></button>)}</div>
        : step === 'connection' ? <form id="add-device" onSubmit={event => { event.preventDefault(); void connect(); }} className="grid gap-4">
          <label className="grid gap-2 typography-meta">{t('bot.workspace.name')}<Input value={name} onChange={event => setName(event.target.value)} /></label>
          <label className="grid gap-2 typography-meta">{t(method === 'ssh' ? 'bot.workspace.connection.ssh' : 'bot.workspace.connection.url')}<Input value={address} placeholder={method === 'ssh' ? 'ssh user@host' : 'https://host:port'} onChange={event => setAddress(event.target.value)} autoFocus /></label>
          {method === 'url' && <label className="grid gap-2 typography-meta">{t('bot.workspace.connection.token')}<Input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" /></label>}
          {method === 'ssh' && imports.length > 0 && <div className="flex flex-wrap gap-2">{imports.map(item => <Button key={item.host} type="button" size="sm" variant="outline" onClick={() => setAddress(item.sshCommand)}>{item.host}</Button>)}</div>}
          <p className="typography-meta text-muted-foreground">{t(method === 'ssh' ? 'bot.workspace.connection.sshHint' : 'bot.workspace.connection.targetHint')}</p>
        </form> : <div className="space-y-4"><h3 className="typography-ui-label">{name || address}</h3>{status && <p role="status" className="typography-meta">{status}</p>}
          {target ? <div className="flex flex-wrap gap-2">{target.capabilities.map(capability => <span className="device-capability" key={capability}><Icon name="check" className="size-3" />{capability}</span>)}</div> : <p className="typography-meta text-muted-foreground">{unavailable?.message ?? t('bot.workspace.connection.checking')}</p>}
          <p className="typography-meta text-muted-foreground">{desktops.length ? desktops.map(desktop => `${desktop.label} · ${desktop.status}`).join('\n') : t('bot.workspace.noDesktop')}</p>
          <p className="typography-meta text-muted-foreground">{t('bot.workspace.connection.preserve')}</p>
        </div>}
    </div>
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    <DialogFooter>{step === 'connection' && <Button variant="ghost" disabled={busy} onClick={() => setStep('method')}>{t('bot.workspace.parent')}</Button>}
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t(step === 'result' ? 'bot.workspace.close' : 'bot.workspace.cancel')}</Button>
      {step === 'method' ? <Button onClick={() => setStep('connection')}>{t('bot.workspace.open')}</Button> : step === 'connection' ? <Button type="submit" form="add-device" disabled={!address.trim() || busy}>{t('bot.workspace.connection.connect')}</Button> : <Button disabled={busy} onClick={() => void refresh()}>{t('bot.workspace.refresh')}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}
