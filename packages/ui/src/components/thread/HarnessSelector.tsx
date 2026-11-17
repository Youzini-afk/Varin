import React from 'react';
import { Popover } from '@base-ui/react/popover';
import type { ExternalAgentSettings, ExternalHarness } from '@varin/application-client';
import { useExternalAgents } from '@/stores/useExternalAgentStore';
import { useSourceExternalAgents } from '@/hooks/useSourceExternalAgents';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { cn } from '@/lib/utils';
import { HarnessIcon } from './HarnessIcon';

type HarnessSelectorProps = {
  value?: string | null;
  harness?: ExternalHarness;
  disabled?: boolean;
  onChange?(id: string | null): void;
  settings?: ExternalAgentSettings | null;
  discoveredAgentIds?: string[];
  loading?: boolean;
  error?: string;
  onRetry?(): void;
  onOpenChange?(open: boolean): void;
  sourceRemote?: boolean;
};

export function HarnessSelector(props: HarnessSelectorProps) {
  return props.settings === undefined ? <LocalHarnessSelector {...props} /> : <HarnessSelectorContent {...props} />;
}

function LocalHarnessSelector(props: HarnessSelectorProps) {
  const settings = useExternalAgents();
  const [opened, setOpened] = React.useState(false);
  const source = useSourceExternalAgents(undefined, opened, true);
  return <HarnessSelectorContent {...props} settings={settings ?? source.settings}
    discoveredAgentIds={source.settings?.discoveredAgentIds} loading={source.loading}
    error={source.error} onRetry={source.retry} onOpenChange={open => {
      if (open) {
        if (opened) source.retry();
        else setOpened(true);
      }
      props.onOpenChange?.(open);
    }} />;
}

function HarnessSelectorContent({
  value, harness, disabled, onChange, settings, discoveredAgentIds = settings?.discoveredAgentIds,
  loading, error, onRetry, onOpenChange, sourceRemote,
}: HarnessSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const agent = settings?.agents.find(v => v.id === value);
  const label = value ? agent?.name ?? value : 'Varin';
  const content = <>
    {value
      ? <HarnessIcon harness={agent?.harness ?? harness} configurationId={value} profileId={agent?.profileId} className="size-3.5" />
      : <VarinLogo decorative width={14} height={14} />}
    <span className="min-w-0 truncate">{label}</span>
  </>;
  const style = 'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground';
  if (!onChange) return <span className={style} title={label}>{content}</span>;

  const selectable = settings?.agents.filter(candidate => candidate.enabled &&
    candidate.availability !== 'disabled' &&
    (candidate.availability !== 'auto' ||
      (discoveredAgentIds?.includes(candidate.id) ??
        settings.detections?.some(detection => detection.id === candidate.id && detection.status === 'available')))) ?? [];
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const select = (id: string | null) => {
    changeOpen(false);
    onChange(id);
  };
  const checkmark = <Icon name="check" className="size-3.5" />;

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger type="button" disabled={disabled} aria-label={t('external.choose')} title={label}
        className={`${style} hover:bg-interactive-hover hover:text-foreground data-[popup-open]:bg-interactive-hover`}>
        {content}
        <Icon name="arrow-down-s" className="size-3 shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={4} className="app-region-no-drag z-50">
          <Popover.Popup aria-label={t('external.choose')}
            style={{ backgroundColor: 'var(--surface-elevated)', color: 'var(--surface-elevated-foreground)' }}
            className={cn(dropdownMenuPopupClass, 'flex max-h-[min(22rem,var(--available-height))] w-[min(17rem,var(--available-width))] min-w-0 flex-col overflow-hidden p-0 outline-none')}>
            <Command className="h-auto min-h-0 rounded-none [&>[data-slot=command-input-wrapper]]:shrink-0" label={t('external.choose')}
              filter={(_id, search, names) => names?.some(name => name.toLowerCase().includes(search.trim().toLowerCase())) ? 1 : 0}>
              <CommandInput aria-label={t('external.manage.search')} placeholder={t('external.manage.search')} />
              <CommandList>
                {!loading && <CommandEmpty className="px-3 py-3 text-left typography-meta text-muted-foreground">
                  {t('commandPalette.empty.noResults')}
                </CommandEmpty>}
                <CommandGroup>
                  <CommandItem value="native" keywords={['Varin']} onSelect={() => select(null)}>
                    <VarinLogo decorative width={16} height={16} />
                    <span className="min-w-0 flex-1 truncate">Varin</span>
                    {!value && checkmark}
                  </CommandItem>
                  {selectable.map(candidate => <CommandItem key={candidate.id} value={`agent:${candidate.id}`}
                    keywords={[candidate.name, settings?.profiles?.find(profile => profile.id === (candidate.profileId ?? candidate.id))?.name ?? '']}
                    onSelect={() => select(candidate.id)}>
                    <HarnessIcon harness={candidate.harness} configurationId={candidate.id} profileId={candidate.profileId} />
                    <span className="min-w-0 flex-1 truncate" title={candidate.name}>{candidate.name}</span>
                    {value === candidate.id && checkmark}
                  </CommandItem>)}
                </CommandGroup>
                {value && settings && !agent && <p role="status" className="px-3 pb-2 typography-meta text-muted-foreground">{t('external.noAgent')}</p>}
                {loading && <p role="status" className="px-3 pb-2 typography-meta text-muted-foreground">{t('common.loading')}</p>}
                {error && <div role="alert" className="break-words px-3 pb-2 typography-meta text-muted-foreground">
                  {error} {onRetry && <button type="button" className="underline" onClick={onRetry}>{t('common.retry')}</button>}
                </div>}
              </CommandList>
            </Command>
            {!sourceRemote && <div className="shrink-0 border-t border-border/60 p-1">
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                onClick={() => {
                  changeOpen(false);
                  const ui = useUIStore.getState();
                  ui.setSettingsPage('external-agents');
                  ui.setSettingsDialogOpen(true);
                }}>
                <Icon name="settings-3" className="size-4 shrink-0" />
                {t('external.manage')}
              </button>
            </div>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
