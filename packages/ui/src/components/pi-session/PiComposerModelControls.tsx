import React from 'react';
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useUIStore } from '@/stores/useUIStore';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import type { PiComposerModelSelection } from './piComposerSessionConfig';

interface PiComposerModelControlsProps {
  active: boolean;
  allowInherit: boolean;
  cwd: string;
  disabled?: boolean;
  effectiveModel?: PiComposerModelSelection;
  effectiveThinkingLevel?: ThinkingLevel;
  onModelChange(model: PiComposerModelSelection | undefined): Promise<void> | void;
  onThinkingChange(level: ThinkingLevel | undefined): Promise<void> | void;
  selectedModel?: PiComposerModelSelection;
  selectedThinkingLevel?: ThinkingLevel;
}

const thinkingLabel = (level: ThinkingLevel | undefined): string => {
  if (!level) return '';
  if (level === 'xhigh') return 'XHigh';
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
};

export const PiComposerModelControls: React.FC<PiComposerModelControlsProps> = ({
  active,
  allowInherit,
  cwd,
  disabled = false,
  effectiveModel,
  effectiveThinkingLevel,
  onModelChange,
  onThinkingChange,
  selectedModel,
  selectedThinkingLevel,
}) => {
  const { t } = useI18n();
  const providers = usePiProviderStore((state) => state.providers);
  const providerCwd = usePiProviderStore((state) => state.cwd);
  const modelPickerOpen = useUIStore((state) => state.isModelSelectorOpen);
  const setModelPickerOpen = useUIStore((state) => state.setModelSelectorOpen);
  const isMobile = useUIStore((state) => state.isMobile);
  const [thinkingPanelOpen, setThinkingPanelOpen] = React.useState(false);

  const effectiveDescriptor = React.useMemo(() => {
    if (!effectiveModel || providerCwd !== cwd) return undefined;
    return providers
      .find((provider) => provider.id === effectiveModel.provider)
      ?.models.find((model) => model.id === effectiveModel.id && model.available);
  }, [cwd, effectiveModel, providerCwd, providers]);

  const thinkingOptions = React.useMemo<ThinkingLevel[]>(() => {
    const supported = effectiveDescriptor?.supportedThinkingLevels;
    return supported && supported.length > 0 ? supported : [...THINKING_LEVELS];
  }, [effectiveDescriptor]);

  const displayedThinking = React.useMemo<ThinkingLevel | undefined>(() => {
    if (effectiveThinkingLevel && thinkingOptions.includes(effectiveThinkingLevel)) {
      return effectiveThinkingLevel;
    }
    if (thinkingOptions.includes('off')) return 'off';
    return thinkingOptions[0];
  }, [effectiveThinkingLevel, thinkingOptions]);

  const handleModelChange = React.useCallback(async (provider: string, id: string) => {
    const next = provider && id ? { id, provider } : undefined;
    try {
      await onModelChange(next);
      if (next && selectedThinkingLevel) {
        const descriptor = providers
          .find((candidate) => candidate.id === next.provider)
          ?.models.find((candidate) => candidate.id === next.id && candidate.available);
        if (descriptor && !descriptor.supportedThinkingLevels.includes(selectedThinkingLevel)) {
          await onThinkingChange(undefined);
        }
      }
      requestAnimationFrame(focusChatInput);
    } catch (error) {
      toast.error(t('chat.modelControls.selectModel'), {
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, [onModelChange, onThinkingChange, providers, selectedThinkingLevel, t]);

  const handleThinkingChange = React.useCallback(async (level: ThinkingLevel | undefined) => {
    try {
      await onThinkingChange(level);
      requestAnimationFrame(focusChatInput);
    } catch (error) {
      toast.error(t('chat.modelControls.thinking'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onThinkingChange, t]);

  const explicitThinking = selectedThinkingLevel !== undefined;
  const displayedThinkingLabel = thinkingLabel(displayedThinking);
  const thinkingTriggerLabel = explicitThinking
    ? thinkingLabel(selectedThinkingLevel)
    : displayedThinkingLabel || t('chat.modelControls.default');

  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-1"
      data-pi-composer-model-controls="true"
    >
      <ModelSelector
        align="end"
        allowNone={allowInherit}
        className="order-2 min-w-0 max-w-[min(220px,55cqi)]"
        cwd={cwd}
        disabled={disabled}
        displayModelId={effectiveModel?.id}
        displayProviderId={effectiveModel?.provider}
        dropdownPortalToBody
        modelId={selectedModel?.id ?? ''}
        onChange={handleModelChange}
        onOpenChange={(open) => {
          if (active) setModelPickerOpen(open);
        }}
        open={active ? modelPickerOpen : false}
        placeholder={allowInherit
          ? t('chat.modelControls.default')
          : t('chat.modelControls.selectModel')}
        providerId={selectedModel?.provider ?? ''}
        variant="composer"
      />

      {isMobile ? (
        <>
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setThinkingPanelOpen(true)}
            className={cn(
              'order-1 flex h-8 max-w-[140px] min-w-0 items-center gap-1.5 px-1 typography-meta transition-opacity hover:opacity-70',
              explicitThinking && selectedThinkingLevel !== 'off'
                ? 'text-[var(--status-info)]'
                : 'text-muted-foreground',
              disabled && 'cursor-not-allowed opacity-60',
            )}
            aria-label={t('chat.modelControls.thinking')}
          >
            <Icon name="brain-ai-3" className="size-4 shrink-0" />
            <span className="truncate font-medium">{thinkingTriggerLabel}</span>
          </button>
          <MobileOverlayPanel
            open={thinkingPanelOpen}
            onClose={() => setThinkingPanelOpen(false)}
            title={t('chat.modelControls.thinking')}
          >
            <div className="flex flex-col gap-1.5">
              {allowInherit ? (
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left typography-meta',
                    !explicitThinking ? 'border-primary/30 bg-primary/10' : 'border-border/40',
                  )}
                  onClick={() => {
                    setThinkingPanelOpen(false);
                    void handleThinkingChange(undefined);
                  }}
                >
                  <span>
                    {displayedThinkingLabel
                      ? `${t('chat.modelControls.default')} · ${displayedThinkingLabel}`
                      : t('chat.modelControls.default')}
                  </span>
                  {!explicitThinking ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
                </button>
              ) : null}
              {thinkingOptions.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left typography-meta',
                    selectedThinkingLevel === level ? 'border-primary/30 bg-primary/10' : 'border-border/40',
                  )}
                  onClick={() => {
                    setThinkingPanelOpen(false);
                    void handleThinkingChange(level);
                  }}
                >
                  <span>{thinkingLabel(level)}</span>
                  {selectedThinkingLevel === level
                    ? <Icon name="check" className="size-4 shrink-0 text-primary" />
                    : null}
                </button>
              ))}
            </div>
          </MobileOverlayPanel>
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                'order-1 flex h-8 max-w-[140px] min-w-0 items-center gap-1.5 px-1 typography-meta transition-opacity hover:opacity-70',
                explicitThinking && selectedThinkingLevel !== 'off'
                  ? 'text-[var(--status-info)]'
                  : 'text-muted-foreground',
                disabled && 'cursor-not-allowed opacity-60',
              )}
              aria-label={t('chat.modelControls.thinking')}
            >
              <Icon name="brain-ai-3" className="size-4 shrink-0" />
              <span className="truncate font-medium">{thinkingTriggerLabel}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[min(200px,calc(100vw-2rem))]" portalToBody>
            <DropdownMenuLabel>{t('chat.modelControls.thinking')}</DropdownMenuLabel>
            {allowInherit ? (
              <>
                <DropdownMenuItem onSelect={() => { void handleThinkingChange(undefined); }}>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="truncate">
                      {displayedThinkingLabel
                        ? `${t('chat.modelControls.default')} · ${displayedThinkingLabel}`
                        : t('chat.modelControls.default')}
                    </span>
                    {!explicitThinking ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {thinkingOptions.map((level) => (
              <DropdownMenuItem
                key={level}
                onSelect={() => { void handleThinkingChange(level); }}
              >
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate">{thinkingLabel(level)}</span>
                  {selectedThinkingLevel === level
                    ? <Icon name="check" className="size-4 shrink-0 text-primary" />
                    : null}
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};
