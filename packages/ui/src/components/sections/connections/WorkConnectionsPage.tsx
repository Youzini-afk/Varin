import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadSourceTargets } from '@varin/application-client';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsPageLink } from '@/components/sections/shared/SettingsPageLink';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isDesktopShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getClientPlatform } from '@/lib/platform';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { listComputers, type ComputerCatalog } from '@/lib/computers';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';

/** A projection of existing connection/source/desktop owners; never another placement profile. */
export function WorkConnectionsPage() {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <WorkConnectionsContent key={generation} />;
}
function WorkConnectionsContent() {
  const { t } = useI18n();
  const { threads } = useRuntimeAPIs();
  const { identity, snapshot, error: threadError } = useSelectedThreadSnapshot();
  const [tab, setTab] = React.useState<'agent' | 'resources'>('agent');
  const [sources, setSources] = React.useState<ThreadSourceTargets | null>(null);
  const [computers, setComputers] = React.useState<ComputerCatalog | null>(null);
  const [sourceError, setSourceError] = React.useState<string | null>(null);
  const [computerError, setComputerError] = React.useState<string | null>(null);
  const [epoch, setEpoch] = React.useState(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setSources(null); setComputers(null); setSourceError(null); setComputerError(null);
    if (threads) void threads.sources.list(identity, abort.signal).then(value => { if (!abort.signal.aborted) setSources(value); }, error => { if (!abort.signal.aborted) setSourceError(String(error)); });
    else setSourceError(t('settings.connections.resourceUnavailable'));
    void listComputers().then(value => { if (!abort.signal.aborted) setComputers(value); }, error => { if (!abort.signal.aborted) setComputerError(String(error)); });
    return () => abort.abort();
  }, [threads, identity, epoch, t]);
  const endpoint = redactSensitiveUrl(getRuntimeApiBaseUrl() || window.location.origin);
  const source = snapshot?.launch?.selection.source;
  const defaultDesktop = computers?.desktops.find(desktop => desktop.id === computers.defaultDesktopId);
  const sourceOwner = source?.resource_owner;
  const sourceName = sourceOwner?.kind === 'managed_host'
    ? sources?.targets.find(target => target.resourceOwner.kind === 'managed_host'
      && target.resourceOwner.hostId === sourceOwner.hostId
      && target.resourceOwner.connectionId === sourceOwner.connectionId
      && target.resourceOwner.endpointIdentity === sourceOwner.endpointIdentity)?.label ?? sourceOwner.hostId
    : source ? t('settings.connections.agentLocal') : t('settings.connections.noSource');
  const sourceSummary = !identity ? t('settings.connections.noConversation')
    : threadError ? t('settings.connections.resourceUnavailable')
    : !snapshot ? t('common.loading') : sourceName;
  const desktopSummary = computerError ? t('settings.connections.resourceUnavailable') : !computers ? t('common.loading')
    : computers.defaultDesktopId ? defaultDesktop?.label ?? t('settings.connections.resourceUnavailable') : t('settings.connections.automaticDesktop');
  return <SettingsPageLayout title={t('settings.page.connections.title')} description={t('settings.connections.description')}
    headerEnd={<Button variant="ghost" size="sm" onClick={() => setEpoch(value => value + 1)}><Icon name="refresh" className="size-4" />{t('settings.common.actions.refresh')}</Button>}>
    <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-muted/40 px-4 py-3 typography-meta text-muted-foreground">
      <span>{t('settings.connections.interface')}: {t(`settings.connections.platform.${getClientPlatform()}`)}</span>
      {isDesktopShell() ? <span>{t(isDesktopLocalOriginActive() ? 'settings.connections.localAgent' : 'settings.connections.remoteAgent')}</span> : null}
    </div>
    <div className="mb-6 grid gap-3 @3xl:grid-cols-3">
      <div className="rounded-xl border border-border/60 p-4"><Icon name="cloud" className="mb-3 size-5 text-muted-foreground" /><h2 className="typography-ui-label">{t('settings.connections.agent')}</h2><p className="mt-2 break-all typography-meta">{endpoint}</p><p className="mt-2 typography-meta text-muted-foreground">{t('settings.connections.agentHint')}</p></div>
      <div className="rounded-xl border border-border/60 p-4"><Icon name="folder" className="mb-3 size-5 text-muted-foreground" /><h2 className="typography-ui-label">{t('settings.connections.files')}</h2><p className="mt-2 typography-meta">{sourceSummary}</p>{source ? <><p className="mt-1 typography-meta text-muted-foreground">{t(`settings.connections.sourceMode.${source.mode}`)}</p><p className="mt-1 break-all font-mono typography-micro text-muted-foreground">{source.live_root?.canonicalRoot ?? (source.mode === 'materialized' ? source.execution_workspace_id : source.workspace_id)}</p></> : null}<p className="mt-2 typography-meta text-muted-foreground">{t('settings.connections.sourceFixed')}</p>{threadError ? <p role="alert" className="typography-meta text-destructive">{threadError}</p> : null}</div>
      <div className="rounded-xl border border-border/60 p-4"><Icon name="computer" className="mb-3 size-5 text-muted-foreground" /><h2 className="typography-ui-label">{t('settings.connections.computerDefault')}</h2><p className="mt-2 typography-meta">{desktopSummary}</p><p className="mt-2 typography-meta text-muted-foreground">{t('settings.connections.computerHint')}</p></div>
    </div>
    <div className="mb-6 flex gap-1 border-b border-border/60" role="tablist" aria-label={t('settings.page.connections.title')}>
      {(['agent', 'resources'] as const).map(value => <Button key={value} variant="ghost" className="rounded-b-none border-b-2 border-transparent aria-selected:border-foreground" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{t(`settings.connections.tab.${value}`)}</Button>)}
    </div>
    {tab === 'agent' ? <SettingsSection title={t('settings.connections.tab.agent')} description={t('settings.connections.switchHint')} divider={false}>
      <DesktopHostSwitcherInline />
      <SettingsPageLink page="remote-instances" description={t('settings.connections.manageHint')}>{t('settings.page.remoteInstances.title')}</SettingsPageLink>
      <SettingsPageLink page="access">{t('settings.page.access.title')}</SettingsPageLink>
      <SettingsPageLink page="tunnel">{t('settings.page.tunnel.title')}</SettingsPageLink>
    </SettingsSection> : <>
      <SettingsSection title={t('settings.connections.files')} description={t('settings.connections.resourceOrigin')} divider={false}>
        {sourceError ? <p role="alert" className="typography-meta text-destructive">{sourceError}</p> : !sources ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : <div className="divide-y divide-border/60">
          {sources.targets.map(target => <div key={target.resourceOwner.kind === 'local' ? 'local' : target.resourceOwner.connectionId} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="typography-ui-label">{target.resourceOwner.kind === 'local' ? t('settings.connections.agentLocal') : target.label}</p><p className="mt-1 typography-meta text-muted-foreground">{target.capabilities.join(' · ')}</p></div><span className="typography-meta">{t('settings.connections.available')}</span></div>)}
          {sources.unavailable.map(target => <div key={target.connectionId} className="py-3"><p className="typography-ui-label">{target.label}</p><p role="status" className="mt-1 typography-meta text-muted-foreground">{target.message}</p></div>)}
        </div>}
        <p className="mt-3 typography-meta text-muted-foreground">{t('settings.connections.chooseInConversation')}</p>
        <p className="mt-2 typography-meta text-muted-foreground">{t('settings.connections.relayBoundary')}</p>
      </SettingsSection>
      <SettingsSection title={t('settings.connections.desktops')} description={t('settings.connections.desktopHint')}>
        {computerError ? <p role="alert" className="typography-meta text-destructive">{computerError}</p> : !computers ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : <div className="divide-y divide-border/60">{computers.desktops.map(desktop => <div key={desktop.id} className="flex items-center justify-between gap-3 py-3"><div><p className="typography-ui-label">{desktop.label}</p><p className="mt-1 typography-meta text-muted-foreground">{computers.machines.find(machine => machine.id === desktop.machineId)?.name ?? desktop.machineId} · {desktop.kind}</p></div><span className="typography-meta text-muted-foreground">{t(desktop.status === 'available' ? 'settings.computers.status.available' : desktop.status === 'stopped' ? 'settings.computers.status.stopped' : 'settings.computers.status.unavailable')}</span></div>)}{!computers.desktops.length ? <p className="typography-meta text-muted-foreground">{t('settings.computers.empty')}</p> : null}</div>}
        <SettingsPageLink page="harness-computers">{t('settings.page.harness.page.computers.title')}</SettingsPageLink>
      </SettingsSection>
    </>}
  </SettingsPageLayout>;
}
