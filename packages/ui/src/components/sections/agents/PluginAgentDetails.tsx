import React from 'react';
import type {
  JsonValue,
  PiAgentActionDescriptor,
  PiAgentDescriptor,
  PiAgentSourceScope,
  PiAgentStatus,
  RuntimeContextTarget,
} from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_HELPER_CLASS,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  runPiAgentProviderAction,
} from '@/lib/pi-runtime/agent-providers';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@varin/application-client';
import { requestPluginSettingsTarget } from '@/lib/settings/plugin-settings-navigation';
import { cn } from '@/lib/utils';
import { AgentProviderActionDialog } from './AgentProviderActionDialog';
import { PiSubagentsDefinitionDialog } from './PiSubagentsDefinitionDialog';
import type { PiSubagentsDefinitionMode } from './pi-subagents-action-model';
import { filterAgentsCatalog } from './agents-catalog-model';
import {
  refreshAgentsCatalog,
  requestAgentsCatalogDefinition,
  useAgentsCatalogState,
} from './agents-catalog-store';

interface AgentActionState {
  action: string;
  agentId?: string;
  loading: boolean;
  message?: string;
  providerId: string;
  success?: boolean;
}

const UNSUPPORTED_VALUE_KEY = 'settings.varin.pluginSettings.field.unsupportedValue' as const;

const AGENT_KIND_LABEL_KEYS: Partial<Record<string, I18nKey>> = {
  delegatable: 'settings.varin.pluginSettings.subagents.kind.delegatable',
  internal: 'settings.varin.agents.kind.internal',
  primary: 'settings.varin.agents.kind.primary',
  profile: 'settings.varin.agents.kind.profile',
  service: 'settings.varin.agents.kind.service',
  workflow: 'settings.varin.pluginSettings.subagents.kind.workflow',
};

const AGENT_STATUS_LABEL_KEYS: Partial<Record<string, I18nKey>> = {
  available: 'settings.varin.pluginSettings.subagents.status.available',
  disabled: 'settings.varin.pluginSettings.subagents.status.disabled',
  error: 'settings.varin.pluginSettings.subagents.status.error',
  unavailable: 'settings.varin.pluginSettings.subagents.status.unavailable',
  unconfigured: 'settings.varin.pluginSettings.subagents.status.unconfigured',
};

const AGENT_THINKING_LABEL_KEYS: Partial<Record<string, I18nKey>> = {
  off: 'settings.varin.pluginSettings.subagents.thinking.off',
  minimal: 'settings.varin.pluginSettings.subagents.thinking.minimal',
  low: 'settings.varin.pluginSettings.subagents.thinking.low',
  medium: 'settings.varin.pluginSettings.subagents.thinking.medium',
  high: 'settings.varin.pluginSettings.subagents.thinking.high',
  xhigh: 'settings.varin.pluginSettings.subagents.thinking.xhigh',
  max: 'settings.varin.pluginSettings.subagents.thinking.max',
};

const AGENT_SOURCE_SCOPE_LABEL_KEYS: Record<PiAgentSourceScope, I18nKey> = {
  builtin: 'settings.varin.pluginSettings.subagents.scope.builtin',
  package: 'settings.varin.pluginSettings.subagents.scope.package',
  project: 'settings.varin.pluginSettings.subagents.scope.project',
  runtime: 'settings.varin.pluginSettings.subagents.scope.runtime',
  user: 'settings.varin.pluginSettings.subagents.scope.user',
};

function displayLocalizedValue(
  value: string,
  labels: Partial<Record<string, I18nKey>>,
  t: (key: I18nKey) => string,
): string {
  const key = labels[value];
  return key ? t(key) : t(UNSUPPORTED_VALUE_KEY);
}

function displayAgentKind(value: string, t: (key: I18nKey) => string): string {
  return displayLocalizedValue(value, AGENT_KIND_LABEL_KEYS, t);
}

function displayAgentStatus(value: string, t: (key: I18nKey) => string): string {
  return displayLocalizedValue(value, AGENT_STATUS_LABEL_KEYS, t);
}

function displayAgentThinking(value: string, t: (key: I18nKey) => string): string {
  return displayLocalizedValue(value, AGENT_THINKING_LABEL_KEYS, t);
}

function displayAgentSourceScope(value: string, t: (key: I18nKey) => string): string {
  return displayLocalizedValue(value, AGENT_SOURCE_SCOPE_LABEL_KEYS, t);
}

function statusTone(status: PiAgentStatus): string {
  switch (status) {
    case 'available':
      return 'text-[var(--status-success)] bg-[color-mix(in_srgb,var(--status-success)_10%,transparent)]';
    case 'error':
    case 'unavailable':
      return 'text-[var(--status-error)] bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)]';
    case 'unconfigured':
      return 'text-[var(--status-warning)] bg-[color-mix(in_srgb,var(--status-warning)_10%,transparent)]';
    case 'disabled':
    default:
      return 'text-muted-foreground bg-interactive-hover';
  }
}

function invocationExample(agent: PiAgentDescriptor): string | null {
  if (!agent.invocation) return null;
  const separator = agent.invocation.taskSeparator === 'double-dash' ? ' -- ' : ' ';
  return `/${agent.invocation.command} ${agent.name}${separator}<task>`;
}

const AgentBadge: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <span className={cn(
    'inline-flex min-w-0 items-center rounded-md px-1.5 py-0.5 typography-micro',
    className,
  )}>
    {children}
  </span>
);

const DetailRow: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
}> = ({ label, value }) => (
  <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2">
    <dt className={cn(SETTINGS_HELPER_CLASS, 'min-w-0')}>{label}</dt>
    <dd className="min-w-0 break-words typography-meta text-foreground">{value}</dd>
  </div>
);

export const PluginAgentDetails: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const runtimeKey = getRuntimeKey();
  const targetKey = JSON.stringify([runtimeKey, runtimeTarget]);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const catalogState = useAgentsCatalogState();
  const catalog = catalogState.catalog;
  const [actionState, setActionState] = React.useState<AgentActionState | null>(null);
  const [definitionMode, setDefinitionMode] = React.useState<PiSubagentsDefinitionMode | null>(null);
  const [dialogAction, setDialogAction] = React.useState<PiAgentActionDescriptor | null>(null);
  const [dialogAgent, setDialogAgent] = React.useState<PiAgentDescriptor | null>(null);

  const refresh = React.useCallback(async (afterMutation = false) => {
    await refreshAgentsCatalog(runtimeTarget, targetKey, afterMutation);
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    setActionState(null);
    setDefinitionMode(null);
    setDialogAction(null);
    setDialogAgent(null);
    void refresh();
  }, [refresh]);

  const providerById = React.useMemo(() => new Map(
    catalog.providers.map((provider) => [provider.id, provider]),
  ), [catalog.providers]);

  const filteredAgents = React.useMemo(() => filterAgentsCatalog(
    catalog,
    catalogState.query,
    catalogState.providerFilter,
    catalogState.statusFilter,
  ).filter(agent => agent.providerId !== 'varin'), [catalog, catalogState.providerFilter, catalogState.query, catalogState.statusFilter]);

  const selectedAgent = React.useMemo(() => (
    filteredAgents.find((agent) => agent.id === catalogState.selectedAgentId)
      ?? filteredAgents[0]
      ?? null
  ), [catalogState.selectedAgentId, filteredAgents]);
  const selectedInvocation = selectedAgent ? invocationExample(selectedAgent) : null;

  const runAction = React.useCallback(async (input: {
    action: string;
    agentId?: string;
    payload?: JsonValue;
    providerId: string;
    refreshCatalog?: boolean;
  }): Promise<boolean> => {
    const actionTargetKey = targetKey;
    setActionState({
      action: input.action,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      loading: true,
      providerId: input.providerId,
    });
    try {
      const result = await runPiAgentProviderAction(
        runtimeTarget,
        input.providerId,
        input.action,
        input.agentId,
        input.payload,
      );
      if (actionTargetKey !== targetKeyRef.current) return false;
      if (result.success && input.refreshCatalog) await refresh(true);
      if (actionTargetKey !== targetKeyRef.current) return false;
      setActionState({
        action: input.action,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        loading: false,
        message: result.message,
        providerId: input.providerId,
        success: result.success,
      });
      return result.success;
    } catch (error) {
      if (actionTargetKey !== targetKeyRef.current) return false;
      setActionState({
        action: input.action,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        loading: false,
        message: error instanceof Error ? error.message : String(error),
        providerId: input.providerId,
        success: false,
      });
      return false;
    }
  }, [refresh, runtimeTarget, targetKey]);

  const openConfiguration = React.useCallback((configuration: PiAgentDescriptor['configuration']) => {
    if (!configuration) return;
    requestPluginSettingsTarget(
      configuration.pluginId,
      configuration.section,
    );
    setSettingsPage('plugin-settings');
  }, [setSettingsPage]);

  const selectedProvider = selectedAgent
    ? providerById.get(selectedAgent.providerId)
    : undefined;
  const activeProvider = selectedProvider;
  const providerActionState = actionState
    && actionState.agentId === undefined
    && actionState.providerId === activeProvider?.id
    ? actionState
    : null;
  const selectedAgentActionState = selectedAgent
    && actionState?.agentId === selectedAgent.id
    ? actionState
    : null;
  const effectiveDefinitionMode = definitionMode ?? catalogState.definitionRequest;
  const definitionAgent = effectiveDefinitionMode === 'update-agent'
    ? selectedAgent ?? undefined
    : undefined;

  const displayActionLabel = React.useCallback((
    providerId: string,
    action: PiAgentActionDescriptor,
    agentKind?: PiAgentDescriptor['kind'],
  ): string => {
    if (providerId !== 'pi-subagents') return action.label;
    switch (action.id) {
      case 'create-agent':
        return t('settings.varin.agents.definition.createAgent');
      case 'models':
        return t('settings.varin.agents.actions.models');
      case 'inspect':
        return t('settings.varin.agents.actions.inspect');
      case 'update':
        return t(agentKind === 'workflow'
          ? 'settings.varin.agents.definition.editWorkflow'
          : 'settings.varin.agents.definition.editAgent');
      case 'delete':
        return t('settings.common.actions.delete');
      case 'eject':
        return t('settings.varin.agents.actions.copyToScope');
      case 'disable':
        return t('settings.varin.agents.actions.disable');
      case 'enable':
        return t('settings.varin.agents.actions.enable');
      case 'reset':
        return t('settings.common.actions.reset');
      default:
        return action.label;
    }
  }, [t]);

  const submitDefinition = React.useCallback(async (
    scope: 'user' | 'project',
    config: Record<string, JsonValue>,
  ): Promise<boolean> => {
    if (!effectiveDefinitionMode) return false;
    const creating = effectiveDefinitionMode === 'create-agent';
    const action = creating ? effectiveDefinitionMode : 'update';
    const agent = creating ? undefined : definitionAgent;
    return runAction({
      action,
      ...(agent === undefined ? {} : { agentId: agent.id }),
      payload: { config, scope },
      providerId: agent?.providerId ?? 'pi-subagents',
      refreshCatalog: true,
    });
  }, [definitionAgent, effectiveDefinitionMode, runAction]);

  const requestAgentAction = React.useCallback((
    agent: PiAgentDescriptor,
    action: PiAgentActionDescriptor,
  ) => {
    if (agent.providerId === 'pi-subagents' && action.id === 'update') {
      setDefinitionMode('update-agent');
      return;
    }
    const inferredScope = agent.source.scope === 'user' || agent.source.scope === 'project'
      ? agent.source.scope
      : undefined;
    if (action.destructive || (action.requiresScope && inferredScope === undefined)) {
      setDialogAgent(agent);
      setDialogAction({ ...action, label: displayActionLabel(agent.providerId, action, agent.kind) });
      return;
    }
    void runAction({
      action: action.id,
      agentId: agent.id,
      ...(action.requiresScope && inferredScope
        ? { payload: { scope: inferredScope } }
        : {}),
      providerId: agent.providerId,
      refreshCatalog: action.id !== 'inspect',
    });
  }, [displayActionLabel, runAction]);

  const submitDialogAction = React.useCallback(async (scope?: 'user' | 'project') => {
    if (!dialogAction || !dialogAgent) return false;
    return runAction({
      action: dialogAction.id,
      agentId: dialogAgent.id,
      ...(scope === undefined ? {} : { payload: { scope } }),
      providerId: dialogAgent.providerId,
      refreshCatalog: true,
    });
  }, [dialogAction, dialogAgent, runAction]);

  return (
    <>
      <SettingsPageLayout
        title={selectedAgent?.name ?? t('settings.page.agents.title')}
        titleAccessory={selectedAgent ? (
          <AgentBadge className={cn('shrink-0', statusTone(selectedAgent.status))}>
            {displayAgentStatus(selectedAgent.status, t)}
          </AgentBadge>
        ) : null}
        description={selectedAgent?.description ?? t('settings.varin.agents.description')}
        headerEnd={(
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsPage('fleet')}>
              <Icon name="pulse" className="size-4" />
              {t('settings.page.fleet.title')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={catalogState.loading}>
              <Icon name="refresh" className={cn('size-4', catalogState.loading && 'animate-spin')} />
              {t('settings.varin.agents.actions.refresh')}
            </Button>
          </div>
        )}
      >
      {catalog.diagnostics.length > 0 ? (
        <SettingsSection
          title={t('settings.varin.agents.diagnostics.title')}
          settingsItem="agents.diagnostics"
        >
          <div className="space-y-2">
            {catalog.diagnostics.map((diagnostic, index) => (
              <div
                key={`${diagnostic.providerId}:${diagnostic.path ?? ''}:${index}`}
                className={cn(
                  'rounded-lg border px-3 py-2 typography-meta',
                  diagnostic.severity === 'error'
                    ? 'border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] text-[var(--status-error)]'
                    : 'border-[color-mix(in_srgb,var(--status-warning)_24%,transparent)] text-[var(--status-warning)]',
                )}
              >
                <div className="font-medium">{providerById.get(diagnostic.providerId)?.label ?? diagnostic.providerId}</div>
                <div className="mt-0.5 break-words">{diagnostic.message}</div>
                {diagnostic.path ? <div className="mt-1 break-all font-mono typography-micro">{diagnostic.path}</div> : null}
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection divider={catalog.diagnostics.length > 0} settingsItem="agents.catalog">
        {selectedAgent ? (
          <div>
            <div className="break-all font-mono typography-micro text-muted-foreground">
              {selectedAgent.providerId}/{selectedAgent.name}
            </div>

            <dl className="mt-3 divide-y divide-border/50">
                  <DetailRow label={t('settings.varin.agents.detail.provider')} value={selectedProvider?.label ?? selectedAgent.providerId} />
                  <DetailRow label={t('settings.varin.agents.detail.kind')} value={displayAgentKind(selectedAgent.kind, t)} />
                  <DetailRow label={t('settings.varin.agents.detail.source')} value={displayAgentSourceScope(selectedAgent.source.scope, t)} />
                  {selectedAgent.source.path ? (
                    <DetailRow label={t('settings.varin.agents.detail.path')} value={<span className="font-mono typography-micro">{selectedAgent.source.path}</span>} />
                  ) : null}
                  {selectedAgent.source.packageName ? (
                    <DetailRow label={t('settings.varin.agents.detail.package')} value={selectedAgent.source.packageName} />
                  ) : null}
                  {selectedInvocation ? (
                    <DetailRow
                      label={t('settings.varin.agents.detail.invocation')}
                      value={<code className="font-mono typography-micro">{selectedInvocation}</code>}
                    />
                  ) : null}
                  <DetailRow
                    label={t('settings.varin.agents.detail.model')}
                    value={selectedAgent.model ?? t('settings.varin.agents.detail.inherited')}
                  />
                  {selectedAgent.thinking ? (
                    <DetailRow label={t('settings.varin.agents.detail.thinking')} value={displayAgentThinking(selectedAgent.thinking, t)} />
                  ) : null}
                  {selectedAgent.fallbackModels?.length ? (
                    <DetailRow label={t('settings.varin.agents.detail.fallbacks')} value={selectedAgent.fallbackModels.join(' → ')} />
                  ) : null}
                  {selectedAgent.aliases?.length ? (
                    <DetailRow label={t('settings.varin.agents.detail.aliases')} value={selectedAgent.aliases.join(', ')} />
                  ) : null}
            </dl>

            {activeProvider ? (
                  <div className="mt-4 border-t border-border/60 pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {activeProvider.configuration ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => openConfiguration(activeProvider.configuration)}>
                          <Icon name="settings-3" className="size-4" />
                          {t('settings.varin.agents.actions.configure')}
                        </Button>
                      ) : null}
                      {activeProvider.actions.map((action) => {
                        const loadingAction = providerActionState?.loading === true && providerActionState.action === action.id;
                        const createAction = activeProvider.id === 'pi-subagents'
                          && action.id === 'create-agent';
                        return (
                          <Button
                            key={action.id}
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!activeProvider.available || actionState?.loading === true}
                            onClick={() => {
                              if (createAction) {
                                setDefinitionMode('create-agent');
                                return;
                              }
                              void runAction({ action: action.id, providerId: activeProvider.id });
                            }}
                          >
                            {loadingAction ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                            {displayActionLabel(activeProvider.id, action)}
                          </Button>
                        );
                      })}
                    </div>
                    {providerActionState?.message ? (
                      <pre className={cn(
                        'mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 typography-micro',
                        providerActionState.success
                          ? 'border-border/60 bg-background/70 text-foreground'
                          : 'border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] text-[var(--status-error)]',
                      )}>
                        {providerActionState.message}
                      </pre>
                    ) : null}
                  </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
                  {selectedAgent.actions.map((action) => {
                    const actionLoading = selectedAgentActionState?.loading === true
                      && selectedAgentActionState.action === action.id;
                    return (
                      <Button
                        key={action.id}
                        type="button"
                        variant={action.destructive ? 'destructive' : 'outline'}
                        size="sm"
                        disabled={actionState?.loading === true}
                        onClick={() => requestAgentAction(selectedAgent, action)}
                      >
                        {actionLoading ? (
                          <Icon name="loader-4" className="size-4 animate-spin" />
                        ) : action.id === 'inspect' ? (
                          <Icon name="information" className="size-4" />
                        ) : null}
                        {displayActionLabel(selectedAgent.providerId, action, selectedAgent.kind)}
                      </Button>
                    );
                  })}
            </div>

            {selectedAgentActionState?.message ? (
                  <pre className={cn(
                    'mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 typography-micro',
                    selectedAgentActionState.success
                      ? 'border-border/60 bg-background/70 text-foreground'
                      : 'border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] text-[var(--status-error)]',
                  )}>
                    {selectedAgentActionState.message}
                  </pre>
            ) : null}
          </div>
        ) : catalogState.loaded ? (
          <div className="rounded-xl border border-dashed border-border/70 p-5 text-center">
            <div className="typography-ui-label font-medium text-foreground">
              {catalog.agents.length === 0
                ? t('settings.varin.agents.empty.title')
                : t('settings.varin.agents.catalog.noMatches')}
            </div>
            {catalog.agents.length === 0 ? (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {catalog.providers.flatMap((provider) => provider.actions.map((action) => ({ action, provider }))).map(({ action, provider }) => {
                  const createAction = provider.id === 'pi-subagents'
                    && action.id === 'create-agent';
                  if (!createAction) return null;
                  return (
                    <Button
                      key={`${provider.id}:${action.id}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!provider.available || actionState?.loading === true}
                      onClick={() => setDefinitionMode('create-agent')}
                    >
                      {displayActionLabel(provider.id, action)}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-center py-8 text-muted-foreground">
            <Icon name="loader-4" className="size-5 animate-spin" />
          </div>
        )}
        {catalogState.error ? (
          <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {catalogState.error}
          </div>
        ) : null}
      </SettingsSection>
      </SettingsPageLayout>
      <PiSubagentsDefinitionDialog
        open={effectiveDefinitionMode !== null}
        mode={effectiveDefinitionMode}
        agent={definitionAgent}
        projectTrusted={catalog.projectTrusted}
        submitting={actionState?.loading === true}
        onOpenChange={(open) => {
          if (!open) setDefinitionMode(null);
          if (!open) requestAgentsCatalogDefinition(null);
        }}
        onSubmit={submitDefinition}
      />
      <AgentProviderActionDialog
        open={dialogAction !== null && dialogAgent !== null}
        action={dialogAction}
        agent={dialogAgent}
        projectTrusted={catalog.projectTrusted}
        submitting={actionState?.loading === true
          && actionState.agentId === dialogAgent?.id
          && actionState.action === dialogAction?.id}
        onOpenChange={(open) => {
          if (!open) {
            setDialogAction(null);
            setDialogAgent(null);
          }
        }}
        onSubmit={submitDialogAction}
      />
    </>
  );
};
