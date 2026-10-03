import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { useModelLists } from '@/hooks/useModelLists';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useUIStore } from '@/stores/useUIStore';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { toModelPickerProvider } from '@/lib/piModelPicker';
import type { ModelMetadata } from '@/types';

interface ModelSelectorProps {
    providerId: string;
    modelId: string;
    onChange: (providerId: string, modelId: string) => Promise<void> | void;
    className?: string;
    allowedProviderIds?: string[];
    placeholder?: string;
    tooltipsEnabled?: boolean;
    dropdownPortalToBody?: boolean;
    /** Runtime directory whose provider catalog should be shown. */
    cwd?: string;
    /** Whether the picker exposes an inherited/not-selected choice. */
    allowNone?: boolean;
    /** Effective model shown while the stored selection is inherited. */
    displayProviderId?: string;
    displayModelId?: string;
    defaultSelectionLabel?: string;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    align?: 'start' | 'center' | 'end';
    variant?: 'field' | 'composer';
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    providerId,
    modelId,
    onChange,
    className,
    allowedProviderIds,
    placeholder,
    tooltipsEnabled = true,
    dropdownPortalToBody = false,
    cwd,
    allowNone = true,
    displayProviderId,
    displayModelId,
    defaultSelectionLabel,
    disabled = false,
    open,
    onOpenChange,
    align = 'start',
    variant = 'field',
}) => {
    const { t } = useI18n();
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const piProviders = usePiProviderStore((state) => state.providers);
    const providers = React.useMemo<ModelPickerProvider[]>(
        () => piProviders.map(toModelPickerProvider),
        [piProviders],
    );
    const providersLoaded = usePiProviderStore((state) => state.loaded);
    const providersLoading = usePiProviderStore((state) => state.isLoading);
    const providersCwd = usePiProviderStore((state) => state.cwd);
    const providerError = usePiProviderStore((state) => state.error);
    const loadProviders = usePiProviderStore((state) => state.load);
    const targetDirectory = (cwd ?? currentDirectory)?.trim();
    const isReady = providersLoaded && !providersLoading && providersCwd === targetDirectory;
    const isUnavailable = providersCwd === targetDirectory && Boolean(providerError) && !providersLoading;
    const triggerDisabled = disabled || (!isReady && !isUnavailable);
    const modelsMetadata = React.useMemo(() => new Map<string, ModelMetadata>(), []);
    const isMobile = useUIStore((state) => state.isMobile);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const { favoriteModelsList, recentModelsList } = useModelLists();
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [isSelecting, setIsSelecting] = React.useState(false);
    const pickerOpen = open ?? (isActuallyMobile ? isMobilePanelOpen : isDropdownOpen);

    const setPickerOpen = React.useCallback((nextOpen: boolean) => {
        onOpenChange?.(nextOpen);
        if (open !== undefined) return;
        if (isActuallyMobile) setIsMobilePanelOpen(nextOpen);
        else setIsDropdownOpen(nextOpen);
    }, [isActuallyMobile, onOpenChange, open]);

    React.useEffect(() => {
        if (!targetDirectory) return;
        void loadProviders(targetDirectory).catch(() => undefined);
    }, [loadProviders, targetDirectory]);

    const retryProviders = () => {
        if (!targetDirectory || disabled) return;
        void loadProviders(targetDirectory, { force: true }).catch(() => undefined);
    };

    const catalogStatus = !isReady ? (
        <>
            <Icon
                name={isUnavailable ? 'error-warning' : 'loader-4'}
                className={cn('h-3.5 w-3.5 shrink-0', isUnavailable
                    ? 'text-[var(--status-error)]'
                    : 'animate-spin text-muted-foreground')}
            />
            <span className="typography-meta whitespace-nowrap text-muted-foreground">
                {isUnavailable ? `${t('common.unavailable')} · ${t('settings.harness.retry')}` : t('common.loading')}
            </span>
        </>
    ) : null;

    const closePicker = React.useCallback(() => {
        setPickerOpen(false);
        setSearchQuery('');
    }, [setPickerOpen]);

    const handleSelect = React.useCallback(async (entry: ModelPickerEntry) => {
        if (disabled || isSelecting) return;
        setIsSelecting(true);
        try {
            await onChange(entry.providerID, entry.modelID);
            addRecentModel(entry.providerID, entry.modelID);
            closePicker();
        } catch {
            // The owner reports selection failures and keeps the picker open.
        } finally {
            setIsSelecting(false);
        }
    }, [addRecentModel, closePicker, disabled, isSelecting, onChange]);

    const handleSelectNone = React.useCallback(async () => {
        if (disabled || isSelecting) return;
        setIsSelecting(true);
        try {
            await onChange('', '');
            closePicker();
        } catch {
            // The owner reports selection failures and keeps the picker open.
        } finally {
            setIsSelecting(false);
        }
    }, [closePicker, disabled, isSelecting, onChange]);

    const labels = React.useMemo(() => ({
        searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
        noResults: t('settings.agents.modelSelector.state.noModelsFound'),
        favorites: t('settings.agents.modelSelector.section.favorites'),
        recent: t('settings.agents.modelSelector.section.recent'),
        keyboardHint: t('settings.agents.modelSelector.keyboardHints'),
        notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
        favorite: t('settings.agents.modelSelector.actions.favorite'),
        unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    }), [placeholder, t]);

    const selectedModel = React.useMemo(
        () => providerId && modelId ? { providerID: providerId, modelID: modelId } : null,
        [modelId, providerId],
    );
    const effectiveProviderId = displayProviderId ?? providerId;
    const effectiveModelId = displayModelId ?? modelId;
    // Show the model's display name (as in the picker list), not the raw provider/model id.
    const triggerLabel = React.useMemo(() => {
        if (!effectiveProviderId || !effectiveModelId) {
            return placeholder || t('settings.agents.modelSelector.notSelected');
        }
        const provider = providers.find((entry) => entry.id === effectiveProviderId);
        const model = provider?.models?.find((entry) => entry.id === effectiveModelId);
        const modelLabel = (typeof model?.name === 'string' && model.name.trim()) || effectiveModelId;
        return !selectedModel && defaultSelectionLabel
            ? `${defaultSelectionLabel} · ${modelLabel}`
            : modelLabel;
    }, [defaultSelectionLabel, effectiveModelId, effectiveProviderId, placeholder, providers, selectedModel, t]);

    const picker = (
        <ModelPickerList
            providers={providers}
            providerOrder={providerOrder}
            favoriteModels={favoriteModelsList}
            recentModels={recentModelsList}
            modelsMetadata={modelsMetadata}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelect={handleSelect}
            labels={labels}
            selectedModel={selectedModel}
            hiddenModels={hiddenModels}
            allowedProviderIds={allowedProviderIds}
            includeNotSelected={allowNone}
            onSelectNone={allowNone ? () => { void handleSelectNone(); } : undefined}
            onEscape={closePicker}
            tooltipsEnabled={tooltipsEnabled && pickerOpen}
            disabled={disabled || isSelecting}
            isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
            onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
        />
    );

    if (isActuallyMobile) {
        return (
            <>
                <button
                    type="button"
                    onClick={isUnavailable ? retryProviders : isReady && !disabled ? () => setPickerOpen(true) : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') event.preventDefault();
                    }}
                    disabled={triggerDisabled}
                    title={isUnavailable ? `${providerError} · ${t('settings.harness.retry')}` : undefined}
                    className={cn(
                        variant === 'composer'
                            ? 'flex h-8 min-w-0 flex-1 items-center justify-between gap-1.5 overflow-hidden px-1 typography-meta text-foreground transition-opacity hover:opacity-70'
                            : dropdownTriggerVariants(),
                        variant === 'field' && 'w-full',
                        className,
                    )}
                >
                    <div className="flex min-w-0 items-center gap-2">
                        {!isReady ? catalogStatus : effectiveProviderId ? (
                            <ProviderLogo providerId={effectiveProviderId} className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="pencil-ai" className="h-3 w-3 text-muted-foreground" />
                        )}
                        {isReady ? <span className="typography-meta font-medium text-foreground truncate">{triggerLabel}</span> : null}
                    </div>
                    {variant !== 'composer' ? <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" /> : null}
                </button>
                <MobileOverlayPanel
                    open={isReady && pickerOpen}
                    onClose={closePicker}
                    title={t('settings.agents.modelSelector.title')}
                >
                    {picker}
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <DropdownMenu open={isReady && pickerOpen} onOpenChange={isReady && !disabled ? setPickerOpen : undefined}>
            <DropdownMenuTrigger asChild>
                <button type="button" disabled={triggerDisabled}
                    onClick={isUnavailable ? retryProviders : undefined}
                    title={isUnavailable ? `${providerError} · ${t('settings.harness.retry')}` : undefined}
                    className={cn(
                    variant === 'composer'
                        ? 'flex h-8 min-w-0 w-fit max-w-[220px] items-center gap-1.5 overflow-hidden px-1 typography-meta text-foreground transition-opacity hover:opacity-70'
                        : dropdownTriggerVariants({ size: 'sm' }),
                    variant === 'field' && 'min-w-0 w-fit overflow-hidden',
                    triggerDisabled && 'opacity-60 cursor-not-allowed',
                    className,
                )}>
                    {!isReady ? catalogStatus : (
                        <>
                            {effectiveProviderId ? <ProviderLogo providerId={effectiveProviderId} className="h-3.5 w-3.5 flex-shrink-0" /> : <Icon name="pencil-ai" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                            <span className="typography-ui-label min-w-0 flex-1 truncate text-left font-normal text-foreground">{triggerLabel}</span>
                        </>
                    )}
                    {variant !== 'composer' ? <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" /> : null}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col" align={align} portalToBody={dropdownPortalToBody}>
                {picker}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
