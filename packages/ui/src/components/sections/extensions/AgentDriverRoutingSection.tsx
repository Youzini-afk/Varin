import React from 'react';
import {
  resolveVarinAgentDriverRouting, serviceRoutingScopeKey, VARIN_AGENT_DRIVER_SERVICE_ID,
  VARIN_AGENT_DRIVER_VERSION, VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY,
  type VarinAgentDriverDescription,
} from '@varin/extension-contract';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { SettingsSection } from '../shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { setVarinExtensionServiceRoute, useVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { serviceRoutingOptions } from '@/lib/extensions/service-routing-options';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { readAgentDriverDescription } from '@/lib/extensions/agent-driver-description';

/** Selection is the existing service-routing document. This is a projection for its native
 * consumer: default is not the only installed extension, and inheritance is not explicit builtin. */
export function AgentDriverRoutingSection() {
  const { t } = useI18n();
  const { snapshot } = useVarinExtensionCatalog();
  const workspaceId = useWorkbenchWorkspaceId();
  const epoch = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [scopeKind, setScopeKind] = React.useState<'user' | 'workspace'>(workspaceId ? 'workspace' : 'user');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [description, setDescription] = React.useState<{ key: string; value?: VarinAgentDriverDescription; error?: string } | null>(null);
  const scope = scopeKind === 'workspace' && workspaceId ? { workspaceId } : { userId: 'default' };
  const context = { userId: 'default', ...(scopeKind === 'workspace' && workspaceId ? { workspaceId } : {}) };
  const providers = snapshot ? serviceRoutingOptions(snapshot).get(`${VARIN_AGENT_DRIVER_SERVICE_ID}@${VARIN_AGENT_DRIVER_VERSION}`) ?? [] : [];
  const resolution = snapshot?.routing.authoritative ? resolveVarinAgentDriverRouting({
    candidates: providers.map(provider => ({ providerKey: provider.providerKey, providerId: provider.providerId ?? provider.providerKey })),
    context, document: snapshot.routing.document,
  }) : null;
  const selected = resolution?.kind === 'extension' ? providers.find(provider => provider.providerKey === resolution.providerKey) : undefined;
  const descriptionKey = selected && snapshot ? `${epoch}:${snapshot.catalog.hostId}:${selected.providerKey}:${selected.providerId ?? 'declared'}` : '';
  const hostId = snapshot?.catalog.hostId;
  const selectedExtensionId = selected?.extensionId;
  const selectedProviderKey = selected?.providerKey;
  React.useEffect(() => { if (!workspaceId && scopeKind === 'workspace') setScopeKind('user'); }, [workspaceId, scopeKind]);
  React.useEffect(() => {
    if (!descriptionKey || !hostId || !selectedExtensionId || !selectedProviderKey) return;
    const api = getRegisteredRuntimeAPIs()?.extensions;
    if (!api) return;
    const abort = new AbortController();
    const assertCurrent = () => {
      if (getRuntimeEndpointGeneration() !== epoch || getRegisteredRuntimeAPIs()?.extensions !== api) throw new Error('Driver inspection Runtime changed');
    };
    void readAgentDriverDescription(api, { extensionId: selectedExtensionId, providerKey: selectedProviderKey,
      hostId, assertCurrent, signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setDescription({ key: descriptionKey, value });
    }).catch(failure => {
      if (!abort.signal.aborted) setDescription({ key: descriptionKey, error: failure instanceof Error ? failure.message : String(failure) });
    });
    return () => abort.abort();
  }, [descriptionKey, epoch, hostId, selectedExtensionId, selectedProviderKey]);
  if (!snapshot?.catalog.authoritative || !snapshot.routing.authoritative || !resolution) return null;
  const exact = snapshot.routing.document.rules.find(rule => rule.serviceId === VARIN_AGENT_DRIVER_SERVICE_ID
    && rule.version === VARIN_AGENT_DRIVER_VERSION && serviceRoutingScopeKey(rule.scope) === serviceRoutingScopeKey(scope));
  const selection = exact?.providerKeys;
  const value = selection === undefined ? '__inherit__' : selection.length === 1 ? selection[0] : '__invalid__';
  const available = (key: string) => key === VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY || providers.some(provider => provider.providerKey === key);
  const label = (key: string) => key === VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY ? t('settings.varin.extensions.driver.builtin')
    : snapshot.catalog.extensions.find(entry => entry.manifest.id === providers.find(provider => provider.providerKey === key)?.extensionId)?.manifest.displayName ?? key;
  const effective = resolution.kind === 'builtin' ? t('settings.varin.extensions.driver.builtin')
    : resolution.kind === 'extension' ? label(resolution.providerKey) : t('settings.varin.extensions.routing.status.unavailable');
  const currentDescription = description?.key === descriptionKey ? description : null;
  return <SettingsSection title={t('settings.varin.extensions.driver.title')} settingsItem="extensions.routing">
    <p className="typography-meta text-muted-foreground">{t('settings.varin.extensions.driver.help')}</p>
    <div className="mt-3 grid gap-3 @xl:grid-cols-2">
      <Select value={scopeKind} disabled={busy} onValueChange={next => setScopeKind(next === 'workspace' ? 'workspace' : 'user')}>
        <SelectTrigger aria-label={t('settings.varin.extensions.driver.scope')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="user">{t('settings.varin.extensions.routing.scope.user')}</SelectItem>
          <SelectItem value="workspace" disabled={!workspaceId}>{t('settings.varin.extensions.routing.scope.workspace')}</SelectItem></SelectContent>
      </Select>
      <Select value={value} disabled={busy} onValueChange={next => {
        const originalEpoch = epoch;
        setBusy(true); setError(null);
        void setVarinExtensionServiceRoute(VARIN_AGENT_DRIVER_SERVICE_ID, VARIN_AGENT_DRIVER_VERSION, scope,
          next === '__inherit__' ? null : [next], snapshot.catalog.hostId).catch(failure => {
          if (getRuntimeEndpointGeneration() === originalEpoch) setError(failure instanceof Error ? failure.message : String(failure));
        }).finally(() => setBusy(false));
      }}>
        <SelectTrigger aria-label={t('settings.varin.extensions.driver.selection')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">{t('settings.varin.extensions.driver.inherit')}</SelectItem>
          <SelectItem value={VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY}>{t('settings.varin.extensions.driver.builtin')}</SelectItem>
          {value === '__invalid__' ? <SelectItem value="__invalid__" disabled>{t('settings.varin.extensions.routing.status.unavailable')}</SelectItem> : null}
          {selection?.length === 1 && !available(selection[0]!) ? <SelectItem value={selection[0]!}>{selection[0]} · {t('settings.varin.extensions.routing.missing')}</SelectItem> : null}
          {providers.map(provider => <SelectItem key={provider.providerKey} value={provider.providerKey}>{label(provider.providerKey)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <p className="mt-2 typography-meta">{t('settings.varin.extensions.driver.effective', { name: effective })}</p>
    {resolution.kind === 'extension' ? <p className="typography-micro text-muted-foreground">{currentDescription?.value
      ? currentDescription.value.recovery === 'checkpoint'
        ? t('settings.varin.extensions.driver.checkpoint', { schema: currentDescription.value.checkpointSchema! })
        : t('settings.varin.extensions.driver.noRecovery')
      : currentDescription?.error ?? t('settings.varin.extensions.driver.inspect')}</p> : null}
    {resolution.routing.diagnostics.map(diagnostic => <p key={diagnostic.code} role="status" className="typography-micro text-[var(--status-warning)]">{diagnostic.message}</p>)}
    {error ? <p role="alert" className="typography-micro text-[var(--status-warning)]">{error}</p> : null}
  </SettingsSection>;
}
