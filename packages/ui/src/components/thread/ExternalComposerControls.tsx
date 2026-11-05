import React from 'react';
import type { ExternalAgentCapabilities } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { externalModelChoice, externalThinkingOptions, normalizeExternalSessionChoice, type ExternalSessionChoice } from './externalSessionChoice';

export interface ExternalComposerOptions {
  capabilities?: ExternalAgentCapabilities;
  source?: 'live' | 'cached';
  choice: ExternalSessionChoice;
  disabled?: boolean;
  retryDisabled?: boolean;
  retryDisabledReason?: string;
  onChange(choice: ExternalSessionChoice): void;
  onInteract(kind: 'focus' | 'input' | 'menu'): void;
  onRetryModels?(): void;
}
export type ExternalSelectorKind = 'model' | 'thinking' | 'mode' | { config: string };

function selector(options: ExternalComposerOptions, kind: ExternalSelectorKind) {
  const { capabilities: caps, choice } = options;
  if (typeof kind === 'object') {
    const config = caps?.configOptions?.find(option => option.id === kind.config);
    return { current: String(config?.currentValue ?? ''), selected: choice.config?.[kind.config], values: config?.type === 'boolean'
      ? [{ id: 'true', name: 'true' }, { id: 'false', name: 'false' }] : config?.options.map(value => ({ id: value.value, name: value.name })) ?? [] };
  }
  return { current: caps?.current?.[kind], selected: choice[kind], values: kind === 'model' ? caps?.models ?? [] : kind === 'mode' ? caps?.modes ?? []
    : externalThinkingOptions(choice, caps).levels?.map(level => ({ id: level, name: level })) ?? [] };
}
function choose(options: ExternalComposerOptions, kind: ExternalSelectorKind, value?: string) {
  const { choice, capabilities, onChange } = options;
  if (typeof kind === 'object') {
    const config = { ...choice.config };
    if (value === undefined) delete config[kind.config]; else config[kind.config] = value;
    onChange({ ...choice, config });
  } else onChange(kind === 'model' ? externalModelChoice(choice, value ?? '', capabilities) : { ...choice, [kind]: value });
}

/** The same next-input menu is used by the toolbar and the slash layer. Never mutates a live session. */
export function ExternalOptionMenu({ options, kind, onComplete }: { options: ExternalComposerOptions; kind: ExternalSelectorKind; onComplete?(): void }) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const { current, selected, values } = selector(options, kind);
  const currentName = values.find(value => value.id === current)?.name ?? current ?? t('external.notReported');
  const apply = (value?: string) => { choose(options, kind, value); onComplete?.(); };
  return <div className="min-w-56 max-w-sm space-y-1 p-1 typography-meta">
    <p className="px-2 py-1 text-muted-foreground">{t('external.nextRequest')}{options.source === 'cached' ? ` · ${t('external.previousCapabilities')}` : ''}</p>
    {kind === 'model' && <input type="search" aria-label={t('external.searchModels')} placeholder={t('external.searchModels')} className="mb-1 w-full rounded border border-border bg-background px-2 py-1.5" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); if (event.key !== 'Escape') event.stopPropagation(); }} />}
    <button type="button" disabled={options.disabled} className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-interactive-hover" onClick={() => apply()}>
      <span>{t('external.inheritCurrent', { current: currentName })}</span>{selected === undefined || selected === '' ? <Icon name="check" className="size-3.5 shrink-0" /> : null}
    </button>
    {kind === 'model' && options.capabilities?.modelsError && <div role="alert" className="space-y-1 px-2 py-1 text-destructive">
      <p>{t('external.modelsError')}: {options.capabilities.modelsError}</p>
      {options.onRetryModels && <button type="button" disabled={options.disabled || options.retryDisabled || Boolean(options.retryDisabledReason)} className="underline" onClick={options.onRetryModels}>{t(options.capabilities.modelsRefresh ? 'external.retryModels' : 'external.reconnect')}</button>}
      {options.retryDisabledReason && <p className="text-muted-foreground">{options.retryDisabledReason}</p>}
    </div>}
    <div className="max-h-64 overflow-y-auto">
      {values.filter(value => `${value.name} ${value.id}`.toLowerCase().includes(query.toLowerCase())).map(value => <button type="button" key={value.id} disabled={options.disabled}
        className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left hover:bg-interactive-hover" onClick={() => apply(value.id)}>
        <span>{typeof kind === 'object' && options.capabilities?.configOptions?.find(option => option.id === kind.config)?.type === 'boolean' ? t(value.id === 'true' ? 'external.yes' : 'external.no') : value.name}</span>{selected === value.id && <Icon name="check" className="size-3.5 shrink-0" />}
      </button>)}
      {!options.capabilities && <p className="px-2 py-2 text-muted-foreground">{t('external.capabilitiesPending')}</p>}
    </div>
  </div>;
}
function OptionChip({ options, kind, label, icon }: { options: ExternalComposerOptions; kind: ExternalSelectorKind; label: string; icon?: React.ComponentProps<typeof Icon>['name'] }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const { selected, current, values } = selector(options, kind);
  const value = selected || current;
  const name = values.find(item => item.id === value)?.name ?? value ?? label;
  return <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (next) options.onInteract('menu'); }}>
    <DropdownMenuTrigger asChild><button type="button" disabled={options.disabled} aria-label={label} title={`${label}: ${name}`}
      className={cn('flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 typography-meta hover:bg-interactive-hover', selected ? 'text-foreground' : 'text-muted-foreground')}>
      {icon && <Icon name={icon} className="size-3.5 shrink-0" />}<span className="max-w-40 truncate">{name}</span>{options.source === 'cached' && <span className="text-muted-foreground/65">{t('external.previousCapabilities')}</span>}
    </button></DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="end" portalToBody><ExternalOptionMenu options={options} kind={kind} onComplete={() => setOpen(false)} /></DropdownMenuContent>
  </DropdownMenu>;
}

export function ExternalModelControls({ options }: { options: ExternalComposerOptions }) {
  const { t } = useI18n();
  return <>{Boolean(externalThinkingOptions(options.choice, options.capabilities).levels?.length || options.capabilities?.modelsError && options.choice.thinking) && <OptionChip options={options} kind="thinking" label={t('chat.context.thinking')} icon="brain" />}
    <OptionChip options={options} kind="model" label={t('external.model')} icon="brain" /></>;
}
function BooleanOption({ options, id, label }: { options: ExternalComposerOptions; id: string; label: string }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const { current, selected } = selector(options, { config: id });
  const checked = (selected ?? current) === 'true';
  return <div className="flex shrink-0 items-center">
    <button type="button" disabled={options.disabled} aria-label={label} aria-pressed={checked}
      className={cn('rounded-md px-2 py-1 typography-meta hover:bg-interactive-hover', selected === undefined ? 'text-muted-foreground' : 'text-foreground')}
      onClick={() => { options.onInteract('menu'); choose(options, { config: id }, checked ? 'false' : 'true'); }}>{label}: {t(checked ? 'external.yes' : 'external.no')}</button>
    <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (next) options.onInteract('menu'); }}>
      <DropdownMenuTrigger asChild><button type="button" disabled={options.disabled} aria-label={t('external.optionSettings', { name: label })} className="rounded px-0.5 py-1 text-muted-foreground hover:bg-interactive-hover"><Icon name="arrow-down-s" className="size-3" /></button></DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" portalToBody><ExternalOptionMenu options={options} kind={{ config: id }} onComplete={() => setOpen(false)} /></DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
export function ExternalModeControls({ options }: { options: ExternalComposerOptions }) {
  const { t } = useI18n();
  const root = React.useRef<HTMLDivElement>(null), row = React.useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = React.useState(false), [open, setOpen] = React.useState(false);
  const caps = options.capabilities;
  const { levels, hideSessionConfig } = externalThinkingOptions(options.choice, caps);
  const generic = caps?.configOptions?.filter(option => !(option.category === 'model' && caps.models.length)
    && !(option.category === 'thought_level' && (levels?.length || hideSessionConfig)) && !(option.category === 'mode' && caps.modes?.length));
  // Measure the actual row and its toolbar neighbours, including long backend-provided labels.
  // The hidden measurement row keeps its intrinsic width while the compact menu is displayed.
  React.useLayoutEffect(() => {
    const node = root.current, content = row.current;
    const footer = node?.closest<HTMLElement>('[data-chat-input-footer]'), parent = node?.parentElement;
    if (!node || !content || !footer || !parent || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const width = footer.clientWidth; if (!width) return;
      const siblings = [...parent.children].filter(item => item !== node).reduce((sum, item) => sum + item.getBoundingClientRect().width + 2, 0);
      const actions = footer.querySelector<HTMLElement>('.conversation-composer-actions');
      const models = footer.querySelector<HTMLElement>('.conversation-composer-models');
      const sameRow = models && Math.abs(models.getBoundingClientRect().bottom - parent.getBoundingClientRect().bottom) < 20;
      const modelControls = models?.firstElementChild;
      const modelWidth = modelControls ? [...modelControls.children].reduce((sum, item) => sum + item.getBoundingClientRect().width + 8, 0) : models?.getBoundingClientRect().width ?? 0;
      const available = width - siblings - (actions?.getBoundingClientRect().width ?? 0) - (sameRow ? modelWidth : 0) - 20;
      setCollapsed(content.scrollWidth > available);
    };
    const observer = new ResizeObserver(measure); observer.observe(footer); observer.observe(content); observer.observe(parent);
    measure(); return () => observer.disconnect();
  });
  if (!caps?.modes?.length && !generic?.length) return null;
  return <div ref={root} className="relative min-w-0">
    <div ref={row} aria-hidden={collapsed || undefined} inert={collapsed || undefined} className="flex w-max items-center gap-0.5 whitespace-nowrap"
      style={collapsed ? { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } : undefined}>
      {Boolean(caps?.modes?.length) && <OptionChip options={options} kind="mode" label={t('external.mode')} icon="shield-user" />}
      {generic?.map(option => option.type === 'boolean' ? <BooleanOption key={option.id} options={options} id={option.id} label={option.name} />
        : <OptionChip key={option.id} options={options} kind={{ config: option.id }} label={option.name} />)}
    </div>
    {collapsed && <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (next) options.onInteract('menu'); }}>
      <DropdownMenuTrigger asChild><button type="button" disabled={options.disabled} className="flex items-center gap-1 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover"><Icon name="settings-3" className="size-3.5" />{t('external.sessionOptions')}</button></DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" portalToBody className="max-h-80 overflow-y-auto">
        {Boolean(caps?.modes?.length) && <section aria-label={t('external.mode')}><p className="px-3 pt-2 typography-meta">{t('external.mode')}</p><ExternalOptionMenu options={options} kind="mode" /></section>}
        {generic?.map(option => <section key={option.id} aria-label={option.name}><p className="px-3 pt-2 typography-meta">{option.name}</p><ExternalOptionMenu options={options} kind={{ config: option.id }} /></section>)}
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
}

/** Cached selections are editable. Only a live directory may invalidate an override. */
export function ExternalChoiceValidation({ options }: { options: ExternalComposerOptions }) {
  const { t } = useI18n();
  const [cleared, setCleared] = React.useState(false);
  React.useEffect(() => {
    if (!options.capabilities || options.source !== 'live') return;
    const normalized = normalizeExternalSessionChoice(options.choice, options.capabilities);
    if (JSON.stringify(normalized) === JSON.stringify(options.choice)) return;
    options.onChange(normalized); setCleared(true);
  }, [options]);
  return cleared ? <p role="status" className="px-3 py-1 typography-meta text-muted-foreground">{t('external.invalidChoice')}</p> : null;
}
