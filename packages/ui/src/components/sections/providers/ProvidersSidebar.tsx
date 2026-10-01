import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore, type PiProviderView } from '@/stores/usePiProviderStore';
import { RiAddLine, RiStackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { useI18n } from '@/lib/i18n';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';

const ADD_PROVIDER_ID = '__add_provider__';

interface ProvidersSidebarProps {
  onItemSelect?: () => void;
}

export const ProvidersSidebar: React.FC<ProvidersSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const providers = usePiProviderStore((state) => state.providers);
  const loadProviders = usePiProviderStore((state) => state.load);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const selectedProviderId = usePiProviderStore((state) => state.selectedProviderId);
  const setSelectedProvider = usePiProviderStore((state) => state.setSelectedProvider);

  React.useEffect(() => {
    void loadProviders(currentDirectory).catch((error: unknown) => {
      console.error('Failed to load Pi providers:', error);
    });
  }, [currentDirectory, loadProviders]);

  const bgClass = 'bg-background';

  const projectProviders = React.useMemo(() => {
    return providers.filter((provider) => provider.details?.locations.project.exists === true);
  }, [providers]);

  const userProviders = React.useMemo(() => {
    return providers.filter((provider) => provider.details?.locations.project.exists !== true);
  }, [providers]);

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.providers.sidebar.title')}</h2>
        <SettingsProjectSelector className="mb-3" />
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.providers.sidebar.total', { count: providers.length })}</span>
          <Button size="sm"
            variant="ghost"
            className="h-7 w-7 px-0 -my-1 text-muted-foreground"
            onClick={() => {
              setSelectedProvider(ADD_PROVIDER_ID);
              onItemSelect?.();
            }}
            aria-label={t('settings.providers.sidebar.actions.connectProviderAria')}
            title={t('settings.providers.sidebar.actions.connectProviderTitle')}
          >
            <RiAddLine className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {providers.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiStackLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.providers.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.providers.sidebar.empty.description')}</p>
          </div>
        ) : (
          <>
            {userProviders.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('settings.providers.sidebar.section.userProviders')}
                </div>
                {userProviders.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => {
                      setSelectedProvider(provider.id);
                      onItemSelect?.();
                    }}
                  />
                ))}
              </>
            )}

            {projectProviders.length > 0 && (
              <>
                <div className={cn('px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground', userProviders.length > 0 ? 'pt-3' : 'pt-2')}>
                  {t('settings.providers.sidebar.section.projectProviders')}
                </div>
                {projectProviders.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => {
                      setSelectedProvider(provider.id);
                      onItemSelect?.();
                    }}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScrollableOverlay>
    </div>
  );
};

const ProviderListItem: React.FC<{
  provider: PiProviderView;
  selectedProviderId: string;
  onSelect: () => void;
}> = ({ provider, selectedProviderId, onSelect }) => {
  const modelCount = provider.modelCount;
  const isSelected = provider.id === selectedProviderId;

  return (
    <div
      key={provider.id}
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        tabIndex={0}
      >
        <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
        <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
          {provider.name || provider.id}
        </span>
        <span className="typography-micro text-muted-foreground/60 flex-shrink-0">
          {modelCount}
        </span>
      </button>
    </div>
  );
};
