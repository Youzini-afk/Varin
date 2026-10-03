import React from 'react';
import type { JsonValue, PiAgentDescriptor } from '@varin/protocol';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runPiAgentProviderAction } from '@/lib/pi-runtime/agent-providers';
import { NativeAgentEditor, type NativeAgentDraftCache } from './NativeAgentEditor';
import { AgentProviderActionDialog } from './AgentProviderActionDialog';
import { PluginAgentDetails } from './PluginAgentDetails';
import { nativeAgentDescription, nativeAgentLabel } from './agents-catalog-model';
import { requestAgentsCatalogDefinition, selectAgentsCatalogAgent, setAgentsCatalogProviderFilter, setAgentsCatalogShowAllFocuses } from './agents-catalog-store';
import { useAgentsPageCatalog } from './useAgentsPageCatalog';

export const AgentsPage: React.FC = () => {
  const catalog = useAgentsPageCatalog();
  return <AgentsDetails key={catalog.targetKey} {...catalog} />;
};

function AgentsDetails({ cwd, runtimeKey, target, refresh, state, catalog, selected, focus }: ReturnType<typeof useAgentsPageCatalog>) {
  const { t } = useI18n();
  const [deleting, setDeleting] = React.useState<PiAgentDescriptor | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<{ agentId: string | null; message: string } | null>(null);
  const drafts = React.useMemo<NativeAgentDraftCache>(() => new Map(), []);
  const inFlight = React.useRef(false);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const act = async (action: string, agent?: PiAgentDescriptor, input?: JsonValue): Promise<boolean> => {
    if (!alive.current || inFlight.current) return false;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const result = await runPiAgentProviderAction(target, 'varin', action, agent?.id, input, runtimeKey);
      if (!alive.current) return false;
      if (!result.success) { setError({ agentId: agent?.id ?? null, message: result.message }); return false; }
      await refresh(true);
      if (!alive.current) return false;
      if (result.agentId && action === 'create-agent') {
        setAgentsCatalogProviderFilter('all');
        const config = input && typeof input === 'object' && !Array.isArray(input) ? input.config : undefined;
        const workFocus = config && typeof config === 'object' && !Array.isArray(config) ? config.workFocus : undefined;
        if (Array.isArray(workFocus) && workFocus.length && !workFocus.includes(focus)) setAgentsCatalogShowAllFocuses(true);
        selectAgentsCatalogAgent(result.agentId);
        requestAgentsCatalogDefinition(null);
      }
      return true;
    } catch (cause) {
      if (alive.current) setError({ agentId: agent?.id ?? null, message: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  };
  const creating = state.definitionRequest === 'create-native';
  const agent = creating ? undefined : selected ?? undefined;
  const revision = catalog.agents.find(entry => entry.providerId === 'varin')?.definition?.revision;
  if (state.definitionRequest === 'create-agent' || (agent && agent.providerId !== 'varin')) {
    return <PluginAgentDetails key={state.definitionRequest ?? agent?.id} agent={state.definitionRequest === 'create-agent' ? null : agent!} />;
  }
  return <>
    <SettingsPageLayout title={agent ? nativeAgentLabel(agent, t) : t(creating ? 'settings.varin.agents.definition.createAgent' : 'settings.page.agents.title')}
      description={agent ? nativeAgentDescription(agent, t) : undefined} showSaveStatus
      titleAccessory={agent ? <span className="typography-micro text-muted-foreground">{t(agent.source.scope === 'builtin' ? 'settings.agents.builtin' : 'settings.agents.custom')}</span> : undefined}
      headerEnd={agent?.source.scope === 'user' ? <Button variant="ghost" size="icon" disabled={pending} aria-label={t('settings.common.actions.delete')} onClick={() => { setError(null); setDeleting(agent); }}><Icon name="delete-bin" className="size-4" /></Button> : undefined}>
      {state.error && <p role="alert" className="mb-4 typography-meta text-destructive">{state.error}</p>}
      {catalog.diagnostics.map((item, index) => <p key={`${item.providerId}:${index}`} role="alert" className="mb-3 typography-meta text-destructive">{item.providerId}: {item.message}</p>)}
      {agent || (creating && revision) ? <NativeAgentEditor key={agent?.id ?? 'new'} agent={agent} cwd={cwd} drafts={drafts} busy={pending} error={error?.agentId === (agent?.id ?? null) ? error.message : undefined}
        onCancel={creating ? () => requestAgentsCatalogDefinition(null) : undefined}
        onSave={(config, expectedRevision) => act(agent ? 'update' : 'create-agent', agent, { expectedRevision: expectedRevision ?? revision ?? '', config })} />
        : <p role="status" className="typography-meta text-muted-foreground">{state.loading ? t('common.loading') : t('settings.agents.page.empty.title')}</p>}
    </SettingsPageLayout>
    <AgentProviderActionDialog open={Boolean(deleting)} action={deleting ? { id: 'delete', label: t('settings.common.actions.delete'), destructive: true } : null}
      agent={deleting} projectTrusted={catalog.projectTrusted} submitting={pending} error={error?.agentId === deleting?.id ? error?.message : undefined} onOpenChange={open => { if (!open) setDeleting(null); }}
      onSubmit={async () => deleting ? act('delete', deleting, { expectedRevision: deleting.definition?.revision ?? '' }) : false} />
  </>;
}
