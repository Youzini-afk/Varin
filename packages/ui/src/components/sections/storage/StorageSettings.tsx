import React from 'react';
import { createStorageHttpAPI, getRuntimeEndpointGeneration, StorageRequestError, subscribeRuntimeEndpointChanged, type StorageCleanupPreview, type StorageCleanupReceipt, type StorageInventory, type StorageScope, type StorageTarget } from '@varin/application-client';
import { RiArrowRightSLine, RiComputerLine, RiFolderLine, RiInformationLine, RiLockLine, RiRefreshLine } from '@remixicon/react';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { storageMessages } from './storage-messages';
import { acknowledgeStorageNavigation, getStorageNavigationTarget, subscribeStorageNavigation } from './storage-navigation';
import './storage.css';

const bytes = (value: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
};
const scopeKey = (scope: StorageScope) => scope.kind === 'workspace' ? `workspace:${scope.workspaceId}` : scope.kind;

export function StorageSettings() {
  const { locale } = useI18n(), m = storageMessages(locale);
  const navigate = useUIStore(state => state.setSettingsPage);
  const [hostEpoch, setHostEpoch] = React.useState(getRuntimeEndpointGeneration);
  const api = React.useMemo(() => createStorageHttpAPI(hostEpoch), [hostEpoch]);
  const navigationTarget = React.useSyncExternalStore(subscribeStorageNavigation, getStorageNavigationTarget, () => null);
  const [scope, setScope] = React.useState<StorageScope>(() => getStorageNavigationTarget()?.scope ?? { kind: 'all' });
  const [deviceId, setDeviceId] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<StorageTarget | undefined>();
  const [unavailableSelection, setUnavailableSelection] = React.useState(false);
  const [inventory, setInventory] = React.useState<StorageInventory | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState<'preview' | 'cleanup' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [access, setAccess] = React.useState<'restricted' | 'unavailable'>('unavailable');
  const [preview, setPreview] = React.useState<StorageCleanupPreview | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [receipt, setReceipt] = React.useState<StorageCleanupReceipt | null>(null);
  const [receiptScope, setReceiptScope] = React.useState<StorageScope | null>(null);
  const [receiptDevice, setReceiptDevice] = React.useState('');
  const [cleanupError, setCleanupError] = React.useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = React.useState(false);
  const request = React.useRef<AbortController | null>(null);
  const alive = React.useRef(true);
  const epoch = React.useRef(hostEpoch);
  const previewRequest = React.useRef(0);
  const viewIdentity = `${hostEpoch}:${deviceId ?? ''}:${target?.hostId ?? ''}:${target?.endpointIdentity ?? ''}:${scopeKey(scope)}`;
  const view = React.useRef(viewIdentity);
  view.current = viewIdentity;
  epoch.current = hostEpoch;
  React.useEffect(() => {
    if (!navigationTarget || navigationTarget.generation !== hostEpoch) return;
    previewRequest.current += 1;
    setScope(navigationTarget.scope); setInventory(null); setDeviceId(null); setTarget(undefined); setUnavailableSelection(false); setPreview(null); setReceipt(null); setBusy(null);
    acknowledgeStorageNavigation(navigationTarget.id);
  }, [navigationTarget, hostEpoch]);
  React.useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      previewRequest.current += 1;
      request.current?.abort(); setInventory(null); setPreview(null); setReceipt(null); setDeviceId(null); setTarget(undefined); setUnavailableSelection(false); setScope({ kind: 'all' }); setBusy(null); setHostEpoch(getRuntimeEndpointGeneration());
    });
    return () => { alive.current = false; request.current?.abort(); unsubscribe(); };
  }, []);
  const refresh = React.useCallback(async () => {
    request.current?.abort();
    if (unavailableSelection) { setScanning(false); return; }
    const controller = new AbortController(); request.current = controller;
    setScanning(true); setError(null);
    try {
      const value = await (target ? api.inventory(scope, controller.signal, target) : api.inventory(scope, controller.signal));
      if (controller.signal.aborted || !alive.current) return;
      setInventory(value); setDeviceId(current => current ?? value.device.id);
    } catch (failure) {
      if (controller.signal.aborted || !alive.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setAccess(failure instanceof StorageRequestError && [401, 403].includes(failure.status) ? 'restricted' : 'unavailable');
    } finally { if (request.current === controller && alive.current) setScanning(false); }
  }, [api, scope, target, unavailableSelection]);
  React.useEffect(() => { void refresh(); }, [refresh]);
  const device = inventory?.devices.find(item => item.id === deviceId) ?? inventory?.device;
  const current = !unavailableSelection;
  const visible = current && inventory && (!deviceId || inventory.device.id === deviceId) && scopeKey(inventory.scope) === scopeKey(scope) ? inventory : null;
  const uncertainZero = visible?.state === 'partial' && visible.bytes === 0;
  const amount = visible && !uncertainZero ? bytes(visible.bytes) : '—';
  const scopeLabel = (value: StorageScope) => value.kind === 'all' ? m.all : value.kind === 'shared' ? m.shared : inventory?.workspaces.find(item => item.id === value.workspaceId)?.name ?? value.workspaceId;
  const inspect = async () => {
    if (!visible?.canCleanup || scanning || busy !== null) return;
    const startedEpoch = hostEpoch;
    const startedView = view.current, requestId = ++previewRequest.current;
    setBusy('preview'); setCleanupError(null); setConfirmationSent(false);
    try {
      const value = await (target ? api.preview(scope, undefined, target) : api.preview(scope));
      if (!alive.current || epoch.current !== startedEpoch || view.current !== startedView || previewRequest.current !== requestId) return;
      setPreview(value); setSelected(new Set(value.candidates.map(item => item.id)));
    } catch (failure) { if (alive.current && epoch.current === startedEpoch && view.current === startedView && previewRequest.current === requestId) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current && epoch.current === startedEpoch && previewRequest.current === requestId) setBusy(null); }
  };
  const cleanup = async () => {
    if (!preview || !selected.size || busy !== null) return;
    const startedEpoch = hostEpoch, startedView = view.current;
    setBusy('cleanup'); setCleanupError(null); setConfirmationSent(true);
    try {
      const value = await api.cleanup(preview.id, [...selected]);
      if (!alive.current || epoch.current !== startedEpoch || view.current !== startedView) return;
      setReceipt(value); setReceiptScope(preview.scope); setReceiptDevice(visible?.device.name ?? ''); setPreview(null); await refresh();
    } catch (failure) {
      if (alive.current && epoch.current === startedEpoch && view.current === startedView) setCleanupError(`${m.receiptUnknown} ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { if (alive.current && epoch.current === startedEpoch && view.current === startedView) setBusy(null); }
  };
  const chooseScope = (key: string) => {
    if (busy !== null) return;
    previewRequest.current += 1;
    setScope(key === 'all' || key === 'shared' ? { kind: key } : { kind: 'workspace', workspaceId: key.slice('workspace:'.length) });
    setPreview(null); setReceipt(null);
  };
  const chooseDevice = (id: string) => {
    if (busy !== null) return;
    const next = inventory?.devices.find(item => item.id === id);
    if (!next) return;
    previewRequest.current += 1; request.current?.abort();
    setDeviceId(id); setTarget(next.current || next.state !== 'ready' ? undefined : next.target);
    setUnavailableSelection(!next.current && (next.state !== 'ready' || !next.target));
    setScope({ kind: 'all' }); setPreview(null); setReceipt(null); setError(null);
  };
  const estimate = preview?.candidates.filter(item => selected.has(item.id)).reduce((sum, item) => sum + item.bytes, 0) ?? 0;
  return <div className="storage-settings" aria-busy={scanning || busy !== null}>
    <div className="storage-settings-scopes" data-settings-item="storage.device">
      <label><span>{m.device}</span><select aria-label={m.device} value={deviceId ?? ''} disabled={!inventory || busy !== null}
        onChange={event => chooseDevice(event.target.value)}>
        {!inventory && <option value="">{m.current}</option>}
        {inventory?.devices.map(item => <option key={item.id} value={item.id}>{item.name}{item.current ? ` · ${m.current}` : item.state === 'ready' ? ` · ${m.remote}` : ` · ${m[item.state]}`}</option>)}
      </select></label>
      <label><span>{m.scope}</span><select aria-label={m.scope} value={scopeKey(scope)} disabled={!current || !visible || busy !== null} onChange={event => chooseScope(event.target.value)}>
        <option value="all">{m.all}</option>
        {scope.kind === 'workspace' && !inventory?.workspaces.some(item => item.id === scope.workspaceId) && <option value={scopeKey(scope)}>{m.requestedScope}: {scope.workspaceId}</option>}
        {inventory?.workspaces.map(item => <option key={item.id} value={`workspace:${item.id}`}>{item.name}</option>)}
        <option value="shared">{m.shared}</option>
      </select></label>
    </div>
    <div className="storage-settings-location"><span><RiComputerLine size={14} />{device?.current ? m.current : device?.name ?? m.current}</span><span>{visible?.root ?? '—'}</span></div>
    {!current ? <section className="storage-settings-unavailable" role="status"><RiLockLine size={28} /><h3>{m[device?.state === 'offline' ? 'offline' : device?.state === 'restricted' ? 'restricted' : 'unsupported']}</h3><p>{m.remoteDescription}</p><strong>—</strong><Button variant="outline" onClick={() => { const local = inventory?.devices.find(item => item.current); if (local) chooseDevice(local.id); }}>{m.refreshDevices}</Button><Button variant="outline" onClick={() => navigate('work-connections')}>{m.connection}</Button></section> : <>
      {error && <div role="alert" className="storage-settings-error"><strong>{m[access]}</strong><p>{m.scanError}</p><p>{error}</p>{target && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { const local = inventory?.devices.find(item => item.current); if (local) chooseDevice(local.id); }}>{m.refreshDevices}</Button>}</div>}
      <section className="storage-settings-overview" data-settings-item="storage.summary">
        <div className="storage-settings-heading"><div><p>{scope.kind === 'workspace' ? m.exclusive : scope.kind === 'shared' ? m.shared : m.summary}</p><div className="storage-settings-total">{amount}</div><p className="storage-settings-muted">{visible?.state === 'partial' ? m.knownSubtotal : scopeLabel(scope)}</p></div>
          <Button size="sm" variant="outline" disabled={scanning || busy !== null} onClick={() => { void refresh(); }}><RiRefreshLine size={14} className={scanning ? 'animate-spin' : undefined} />{scanning ? m.scanning : m.refresh}</Button>
        </div>
        <div className="storage-settings-bar" role="img" aria-label={visible ? visible.categories.map(item => `${m[item.id]}: ${uncertainZero ? m.unknown : bytes(item.bytes)}`).join(', ') : m.unknown}>
          {visible && !uncertainZero && visible.categories.map(item => item.bytes > 0 ? <span key={item.id} className={`storage-category-${item.id}`} style={{ width: `${item.bytes / visible.bytes * 100}%` }} /> : null)}
        </div>
        <div className="storage-settings-legend">{(['recovery', 'copies', 'conversations', 'indexes', 'models', 'other'] as const).map(id => {
          const count = visible?.categories.find(item => item.id === id)?.bytes;
          return <div key={id}><i className={`storage-category-${id}`} /><div><strong>{m[id]}</strong><p>{count === undefined || uncertainZero || (count === 0 && visible?.state === 'partial') ? '—' : bytes(count)}<span>{visible && !uncertainZero && visible.bytes > 0 && count !== undefined && !(count === 0 && visible.state === 'partial') ? `${(count / visible.bytes * 100).toFixed(1)}%` : '—'}</span></p></div></div>;
        })}</div>
        <div className="storage-settings-scan" role="status"><span>{scanning ? visible ? m.oldSnapshot : m.scanning : visible ? `${visible.state === 'partial' ? m.partial : m.scanned} · ${new Date(visible.scannedAt).toLocaleTimeString(locale)}` : m.unknown}</span></div>
        {visible?.volumes.map(volume => <p className="storage-settings-volume" key={volume.path}>{m.disk}: {volume.totalBytes === null ? m.unknown : `${bytes(volume.availableBytes!)} ${m.available} / ${bytes(volume.totalBytes)} ${m.total}`}<span>{volume.path}</span></p>)}
        <p className="storage-settings-muted">{m.diskNote}</p>
        {visible?.issues.length ? <details className="storage-settings-details"><summary>{m.issues} ({visible.issues.length})</summary><ul>{visible.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details> : null}
      </section>
      {receipt && <div role="status" className="storage-settings-receipt"><strong>{receipt.state === 'complete' ? m.success : m.incomplete}</strong><p>{receipt.state === 'partial' && receipt.bytesReclaimed === 0 ? m.unconfirmedAmount : `${bytes(receipt.bytesReclaimed)} ${m.reclaimed}`} · {receiptDevice} · {scopeLabel(receiptScope ?? scope)}</p>{receipt.failures.map(item => <p key={item.id}>{item.message}</p>)}</div>}
      <SettingsSection title={m.organize} settingsItem="storage.cleanup">
        <SettingsFieldRow label={m.cleanupTitle} description={m.cleanupDescription}><Button variant="outline" size="sm" disabled={!visible || !visible.canCleanup || scanning || busy !== null} onClick={() => { void inspect(); }}>{busy === 'preview' ? m.scanning : m.inspect}</Button></SettingsFieldRow>
        {visible && !visible.canCleanup && <p className="storage-settings-muted">{m.cleanupRestricted}</p>}
        <SettingsFieldRow label={m.copies} description={m.copiesDescription}><RiLockLine size={16} className="text-muted-foreground" /></SettingsFieldRow>
        <SettingsFieldRow label={m.history} description={target ? m.remoteHistoryDescription : m.historyDescription}><Button variant="outline" size="sm" disabled={!!target} onClick={() => navigate('history')}>{m.history}</Button></SettingsFieldRow>
      </SettingsSection>
      {scope.kind === 'all' && visible ? <SettingsSection title={m.workspaces} description={m.workspaceDescription} settingsItem="storage.workspaces">
        {visible.workspaces.map(item => <button disabled={busy !== null} className="storage-settings-workspace" key={item.id} onClick={() => chooseScope(`workspace:${item.id}`)}><RiFolderLine size={19} /><span><strong>{item.name}</strong><small>{item.path}</small></span><span>{visible.state === 'partial' && item.bytes === 0 ? '—' : bytes(item.bytes)}</span><RiArrowRightSLine size={16} /></button>)}
        <button disabled={busy !== null} className="storage-settings-workspace" onClick={() => chooseScope('shared')}><RiComputerLine size={19} /><span><strong>{m.shared}</strong><small>{m.sharedDescription}</small></span><span>{visible.state === 'partial' && visible.sharedBytes === 0 ? '—' : bytes(visible.sharedBytes)}</span><RiArrowRightSLine size={16} /></button>
      </SettingsSection> : scope.kind === 'workspace' ? <p className="storage-settings-muted storage-settings-scope-note"><RiInformationLine size={16} />{m.scopeNote}<Button disabled={busy !== null} size="sm" variant="ghost" onClick={() => chooseScope('all')}>{m.all}</Button></p> : null}
      <p className="storage-settings-footnote">{m.footnote}</p>
    </>}
    <Dialog open={preview !== null} onOpenChange={open => { if (!open && busy !== 'cleanup') setPreview(null); }}>
      <DialogContent className="storage-settings-dialog" showCloseButton={busy !== 'cleanup'}>
        <DialogHeader><DialogTitle>{m.previewTitle}</DialogTitle><DialogDescription>{m.previewDescription}</DialogDescription></DialogHeader>
        <div className="storage-settings-clean-target"><RiComputerLine size={20} /><div><strong>{inventory?.device.name}</strong><p>{preview ? scopeLabel(preview.scope) : ''}</p><small>{inventory?.root}</small></div></div>
        <div className="storage-settings-candidates">{preview?.candidates.length ? preview.candidates.map(item => <label key={item.id} className="storage-settings-candidate"><input type="checkbox" checked={selected.has(item.id)} disabled={busy === 'cleanup' || confirmationSent} onChange={event => { if (confirmationSent) return; setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} /><span><strong>{item.kind === 'unreferenced-objects' ? m.unreferenced : m.retained}</strong><p>{item.kind === 'unreferenced-objects' ? m.unreferencedDescription : m.retainedDescription}</p><small>{item.location}</small></span><span>{bytes(item.bytes)}</span></label>) : <p>{m.empty}</p>}</div>
        {preview?.scope.kind === 'workspace' && <p className="storage-settings-muted">{m.sharedCleanup}</p>}
        <p className="storage-settings-protected"><RiLockLine size={15} />{m.protected}</p>
        {preview?.issues.map((issue, index) => <p role="alert" className="storage-settings-error" key={index}>{issue}</p>)}
        {cleanupError && <p role="alert" className="storage-settings-error">{cleanupError}</p>}
        <DialogFooter><div className="storage-settings-estimate">{m.estimated}<strong>{bytes(estimate)}</strong></div><Button variant="outline" disabled={busy === 'cleanup'} onClick={() => setPreview(null)}>{confirmationSent ? m.close : m.cancel}</Button><Button disabled={!selected.size || busy === 'cleanup'} onClick={() => { void cleanup(); }}>{busy === 'cleanup' ? m.cleaning : confirmationSent ? m.retryReceipt : m.confirm}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
