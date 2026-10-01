import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsChipGroup,
  SettingsSection,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { PROVIDER_INFERENCE_CAPABILITIES } from '@varin/protocol';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  deletePiProviderConfig,
} from '@/lib/pi-runtime/providers';
import {
  usePiProviderStore,
} from '@/stores/usePiProviderStore';
import { cn } from '@/lib/utils';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { CustomProviderEditor } from './CustomProviderEditor';
import { ProviderAuthPanel } from './ProviderAuthPanel';
import { createEmptyCustomProviderState } from './customProviderForm';
import type { CustomProviderEditableFormState } from './customProviderForm';
import {
  buildProviderSourcesFromDetails,
  canEditProviderFromDetails,
  editableProviderFromDetails,
} from './providerDetailConfig';

const ADD_PROVIDER_ID = '__add_provider__';

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
  notation: 'compact',
}).format(value);

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value === 0) return '0';
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const allProviders = usePiProviderStore((state) => state.allProviders);
  const providers = usePiProviderStore((state) => state.providers);
  const isLoading = usePiProviderStore((state) => state.isLoading);
  const loadError = usePiProviderStore((state) => state.error);
  const loadProviders = usePiProviderStore((state) => state.load);
  const selectedProviderId = usePiProviderStore((state) => state.selectedProviderId);
  const setSelectedProvider = usePiProviderStore((state) => state.setSelectedProvider);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);
  const [modelQuery, setModelQuery] = React.useState('');
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerDropdownOpen, setProviderDropdownOpen] = React.useState(false);
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const [addProviderMode, setAddProviderMode] = React.useState<'known' | 'custom'>('known');
  const [editingCustomProvider, setEditingCustomProvider] = React.useState(false);
  const [customProviderEditState, setCustomProviderEditState] = React.useState<CustomProviderEditableFormState>(
    createEmptyCustomProviderState,
  );
  const [disconnecting, setDisconnecting] = React.useState(false);

  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);

  React.useEffect(() => {
    void loadProviders(currentDirectory, { force: true }).catch((error: unknown) => {
      console.error('Failed to load Pi providers:', error);
    });
  }, [currentDirectory, loadProviders]);

  React.useEffect(() => {
    if (isAddMode) {
      setAddProviderMode('known');
      setEditingCustomProvider(false);
      return;
    }
    if (providers.length === 0) return;
    if (!selectedProviderId || !providers.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProvider(providers[0]?.id ?? ADD_PROVIDER_ID);
    }
  }, [isAddMode, providers, selectedProviderId, setSelectedProvider]);

  React.useEffect(() => {
    setEditingCustomProvider(false);
    setShowAuthPanel(selectedProvider?.auth.configured !== true);
  }, [selectedProvider?.auth.configured, selectedProviderId]);

  const unconnectedProviders = React.useMemo(() => (
    allProviders
      .filter((provider) => !provider.connected)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
  ), [allProviders]);

  React.useEffect(() => {
    if (candidateProviderId && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)) {
      setCandidateProviderId('');
    }
  }, [candidateProviderId, unconnectedProviders]);

  const candidateProvider = allProviders.find((provider) => provider.id === candidateProviderId);
  const selectedSources = selectedProvider?.details
    ? buildProviderSourcesFromDetails(selectedProvider.details)
    : undefined;
  const canEditSelectedProvider = canEditProviderFromDetails(selectedProvider?.details);

  const handleAuthenticated = async (providerId: string) => {
    setSelectedProvider(providerId);
    setShowAuthPanel(false);
  };

  const handleDisconnectProvider = async (providerId: string) => {
    setDisconnecting(true);
    try {
      await deletePiProviderConfig(currentDirectory, providerId, 'all');
      const catalog = await loadProviders(currentDirectory, { force: true });
      const next = catalog.find((provider) => provider.connected && provider.id !== providerId);
      setSelectedProvider(next?.id ?? ADD_PROVIDER_ID);
      toast.success(t('settings.providers.page.toast.providerDisconnected'));
    } catch (error) {
      console.error('Failed to disconnect Pi provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleCustomProviderSaved = (providerId: string) => {
    setEditingCustomProvider(false);
    setSelectedProvider(providerId);
  };

  const handleEditCustomProvider = () => {
    const editable = editableProviderFromDetails(selectedProvider?.details);
    if (!editable) {
      toast.error(t('settings.providers.page.toast.customProviderConfigUnavailable'));
      return;
    }
    setCustomProviderEditState(editable);
    setEditingCustomProvider(true);
  };

  if (!isAddMode && isLoading && providers.length === 0) {
    return <div className="flex h-full items-center justify-center typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</div>;
  }

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">
            {loadError || t('settings.providers.page.empty.checkProviderConfiguration')}
          </p>
          <Button variant="outline" size="xs" className="mt-3 !font-normal" onClick={() => setSelectedProvider(ADD_PROVIDER_ID)}>
            {t('settings.providers.page.actions.connect')}
          </Button>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <SettingsPageLayout title={t('settings.providers.page.connect.title')} showSaveStatus={false}>
        <SettingsSection divider={false}>
          <SettingsChipGroup
            value={addProviderMode}
            onChange={setAddProviderMode}
            aria-label={t('settings.providers.page.connect.title')}
            options={[
              { value: 'known', label: t('settings.providers.page.connect.knownProvider') },
              { value: 'custom', label: t('settings.providers.page.connect.customProvider') },
            ]}
          />
        </SettingsSection>

        {addProviderMode === 'custom' ? (
          <SettingsSection title={t('settings.providers.page.connect.customProvider')} settingsItem="providers.custom">
            <p className="typography-meta text-muted-foreground py-1.5">
              {t('settings.providers.page.connect.description')}
            </p>
            <CustomProviderEditor
              mode="create"
              onSaved={handleCustomProviderSaved}
              onCancel={() => setAddProviderMode('known')}
            />
          </SettingsSection>
        ) : (
          <>
            <SettingsSection title={t('settings.providers.page.connect.selectProviderTitle')} settingsItem="providers.connect">
              <p className="typography-meta text-muted-foreground py-1.5">
                {t('settings.providers.page.connect.description')}
              </p>
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.connect.providerField')}</span>
                {isLoading ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>
                ) : loadError ? (
                  <p className="typography-meta text-[var(--status-error)]">{loadError}</p>
                ) : unconnectedProviders.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.providers.page.connect.allProvidersConnected')}</p>
                ) : (
                  <DropdownMenu open={providerDropdownOpen} onOpenChange={(open) => {
                    setProviderDropdownOpen(open);
                    if (!open) setProviderSearchQuery('');
                  }}>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className={SETTINGS_CUSTOM_TRIGGER_CLASS}>
                        <span className="flex min-w-0 items-center gap-2">
                          {candidateProviderId && <ProviderLogo providerId={candidateProviderId} className="h-3.5 w-3.5 shrink-0" />}
                          <span className={cn('truncate typography-ui-label font-normal', candidateProviderId ? 'text-foreground' : 'text-muted-foreground')}>
                            {candidateProvider?.name || candidateProviderId || t('settings.providers.page.connect.selectProviderPlaceholder')}
                          </span>
                        </span>
                        <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-[280px] p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
                      <div className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3 py-2" onKeyDown={(event) => event.stopPropagation()}>
                        <Icon name="search" className="h-4 w-4 text-muted-foreground" />
                        <input
                          value={providerSearchQuery}
                          onChange={(event) => setProviderSearchQuery(event.target.value)}
                          onKeyDown={(event) => event.stopPropagation()}
                          placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                          className="flex-1 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                          autoFocus
                        />
                      </div>
                      <ScrollableOverlay outerClassName="max-h-[240px]" className="p-1">
                        {unconnectedProviders.filter((provider) => {
                          const query = providerSearchQuery.trim().toLowerCase();
                          return !query || provider.id.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query);
                        }).map((provider) => (
                          <DropdownMenuItem
                            key={provider.id}
                            onSelect={() => {
                              setCandidateProviderId(provider.id);
                              setProviderDropdownOpen(false);
                            }}
                          >
                            <ProviderLogo providerId={provider.id} className="mr-2 h-4 w-4 shrink-0" />
                            <span className="truncate">{provider.name || provider.id}</span>
                          </DropdownMenuItem>
                        ))}
                      </ScrollableOverlay>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </SettingsSection>

            {candidateProvider && (
              <SettingsSection title={t('settings.providers.page.auth.title')} settingsItem="providers.auth">
                <ProviderAuthPanel
                  key={candidateProvider.id}
                  cwd={currentDirectory}
                  methods={candidateProvider.auth.methods}
                  onAuthenticated={handleAuthenticated}
                  providerId={candidateProvider.id}
                />
              </SettingsSection>
            )}
          </>
        )}
      </SettingsPageLayout>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center typography-meta text-muted-foreground">
        {t('settings.providers.page.empty.selectProviderFromSidebar')}
      </div>
    );
  }

  if (editingCustomProvider) {
    return (
      <SettingsPageLayout
        title={selectedProvider.name || selectedProvider.id}
        titleLeading={<ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />}
        description={<span className="font-mono typography-settings-description text-muted-foreground">{selectedProvider.id}</span>}
        showSaveStatus={false}
      >
        <SettingsSection title={t('settings.providers.page.custom.editTitle')} divider={false} settingsItem="providers.custom-edit">
          <CustomProviderEditor
            mode="edit"
            initialState={customProviderEditState}
            onSaved={handleCustomProviderSaved}
            onCancel={() => setEditingCustomProvider(false)}
          />
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  const providerModels = selectedProvider.models;
  const query = modelQuery.trim().toLowerCase();
  const filteredModels = providerModels.filter((model) => (
    !query || model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)
  ));

  return (
    <SettingsPageLayout
      title={selectedProvider.name || selectedProvider.id}
      titleLeading={<ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />}
      description={<span className="font-mono typography-settings-description text-muted-foreground">{selectedProvider.id}</span>}
      headerEnd={canEditSelectedProvider ? (
        <Button variant="outline" size="xs" className="!font-normal" onClick={handleEditCustomProvider}>
          {t('settings.providers.page.actions.editProvider')}
        </Button>
      ) : undefined}
      showSaveStatus={false}
    >
      <SettingsSection
        title={t('settings.providers.page.auth.title')}
        divider={false}
        headerAction={(
          <Button variant="outline" size="xs" className="!font-normal" onClick={() => setShowAuthPanel((value) => !value)}>
            {showAuthPanel ? t('settings.providers.page.actions.hide') : t('settings.providers.page.actions.reconnect')}
          </Button>
        )}
        settingsItem="providers.auth"
      >
        {showAuthPanel ? (
          <ProviderAuthPanel
            key={selectedProvider.id}
            cwd={currentDirectory}
            methods={selectedProvider.auth.methods}
            onAuthenticated={handleAuthenticated}
            providerId={selectedProvider.id}
          />
        ) : (
          <div className="flex items-center gap-1.5 py-1.5">
            <Icon name="check" className="h-4 w-4 shrink-0 text-[var(--status-success)]" />
            <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.connected')}</span>
            {selectedProvider.auth.label && <span className="typography-meta text-muted-foreground">{selectedProvider.auth.label}</span>}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.providers.page.connectionDetails.title')} settingsItem="providers.connection-details">
        <div className="flex flex-col gap-2 py-1.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-8">
          <span className="typography-meta text-muted-foreground">
            {selectedSources && Object.values(selectedSources).some((source) => source.exists)
              ? `${t('settings.providers.page.connectionDetails.configuredIn')} ${[
                  selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                  selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                  selectedSources.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                  selectedSources.custom.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                ].filter(Boolean).join(', ')}`
              : t('settings.providers.page.connectionDetails.noActiveSource')}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
            onClick={() => void handleDisconnectProvider(selectedProvider.id)}
            disabled={disconnecting}
          >
            {disconnecting ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.providers.page.models.title')}
        titleAccessory={providerModels.length > 0 ? <span className="typography-micro text-muted-foreground font-normal">({providerModels.length})</span> : null}
        headerAction={(
          <div className="flex items-center gap-1">
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => hideAllModels(selectedProvider.id, providerModels.map((model) => model.id))}>
              {t('settings.providers.page.actions.hideAll')}
            </Button>
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => showAllModels(selectedProvider.id)}>
              {t('settings.providers.page.actions.showAll')}
            </Button>
          </div>
        )}
        settingsItem="providers.models"
      >
        <div className="relative mb-2">
          <Icon name="search" className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t('settings.providers.page.models.filterPlaceholder')} className="h-7 w-full pl-8" />
        </div>
        {filteredModels.length === 0 ? (
          <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
        ) : (
          <div className="divide-y divide-[var(--surface-subtle)]">
            {filteredModels.map((model) => {
              const isHidden = hiddenModels.some((item) => item.providerID === selectedProvider.id && item.modelID === model.id);
              const contextTokens = formatTokens(model.contextWindow);
              const outputTokens = formatTokens(model.maxTokens);
              const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
              if (model.supportedThinkingLevels.some((level) => level !== 'off')) {
                capabilityIcons.push({ key: 'reasoning', icon: 'brain-ai-3', label: t('settings.providers.page.models.capability.reasoning') });
              }
              if (model.input.includes('image')) {
                capabilityIcons.push({ key: 'image', icon: 'file-image', label: t('settings.providers.page.models.capability.imageInput') });
              }
              return (
                <div key={model.id} className="py-1.5">
                  <div className={cn('flex items-center gap-3', isHidden && 'opacity-50')}>
                    <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">{model.name || model.id}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {(contextTokens || outputTokens) && (
                        <span className="typography-micro text-muted-foreground shrink-0 rounded bg-[var(--surface-muted)] px-1.5 py-0.5">
                          {contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : ''}
                          {contextTokens && outputTokens ? ' / ' : ''}
                          {outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : ''}
                        </span>
                      )}
                      {capabilityIcons.map(({ key, icon, label }) => (
                        <span key={key} className="flex h-5 w-5 items-center justify-center rounded bg-[var(--surface-muted)] text-muted-foreground" title={label} aria-label={label}>
                          <Icon name={icon} className="h-3 w-3" />
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={() => toggleHiddenModel(selectedProvider.id, model.id)}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--interactive-hover)]/50 hover:text-foreground"
                        title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                        aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                      >
                        <Icon name={isHidden ? 'eye-off' : 'eye'} className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
      {PROVIDER_INFERENCE_CAPABILITIES.map(kind => {
        const capability = selectedProvider.details?.capabilities?.[kind];
        if (!capability || capability.enabled === false) return null;
        return <SettingsSection key={kind} title={t(`settings.providers.page.custom.capability.${kind}`)} settingsItem={`providers.${kind}`}>
          <p className="typography-meta text-muted-foreground">{capability.protocol}</p>
          {kind === 'decision' && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.capability.decisionTasks')}</p>}
          {(capability.models ?? []).map(model => <div key={model.id} className="flex items-center justify-between gap-2 py-1.5 typography-meta">
            <span className="truncate">{model.name || model.id}</span><span className="font-mono text-muted-foreground">{model.id}</span>
          </div>)}
          {!capability.models?.length && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.capability.manualModels')}</p>}
        </SettingsSection>;
      })}
    </SettingsPageLayout>
  );
};
