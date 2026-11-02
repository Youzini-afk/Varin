import React from 'react';
import type { ExternalAgentCapabilities } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { externalModelChoice, externalThinkingOptions, type ExternalSessionChoice } from './externalSessionChoice';

export function ExternalSessionControls({ capabilities, choice, disabled, onChange, onCommand, onRetryModels }: {
  capabilities: ExternalAgentCapabilities;
  choice: ExternalSessionChoice;
  disabled?: boolean;
  onChange(value: ExternalSessionChoice): void;
  onCommand?(text: string): void;
  onRetryModels?(): void;
}) {
  const { t } = useI18n();
  const effective = capabilities.current;
  const { levels, hideSessionConfig } = externalThinkingOptions(choice, capabilities);
  const generic = capabilities.configOptions?.filter(option =>
    !(option.category === 'model' && capabilities.models.length) &&
    !(option.category === 'thought_level' && (levels?.length || hideSessionConfig)) &&
    !(option.category === 'mode' && capabilities.modes?.length));
  const selectClass = 'max-w-48 rounded-md border border-border/60 bg-background px-2 py-1 typography-meta';
  // Clear stale effort in the retained draft too, not just in the outgoing payload.
  React.useEffect(() => {
    const invalidThinking = choice.thinking && !levels?.includes(choice.thinking);
    const hiddenEffort = hideSessionConfig ? capabilities.configOptions?.filter(option => option.category === 'thought_level' && choice.config?.[option.id] !== undefined) : undefined;
    if (!invalidThinking && !hiddenEffort?.length) return;
    const config = { ...choice.config };
    for (const option of hiddenEffort ?? []) delete config[option.id];
    onChange({ ...choice, ...(invalidThinking ? { thinking: undefined } : {}), ...(hiddenEffort?.length ? { config } : {}) });
  }, [choice, levels, hideSessionConfig, capabilities.configOptions, onChange]);
  return <div className="min-w-0 space-y-2 typography-meta">
    <p className="break-words text-muted-foreground" aria-label={t('external.current')}>
      {t('external.current')}: {effective?.model || t('external.notReported')}
      {effective?.thinking ? ` · ${t('chat.context.thinking')}: ${effective.thinking}` : ''}
      {effective?.mode ? ` · ${t('external.mode')}: ${effective.mode}` : ''}
    </p>
    {capabilities.modelsError && <div className="space-y-1">
      <p role="alert" className="break-words text-destructive">{t('external.modelsError')}: {capabilities.modelsError}</p>
      {onRetryModels && capabilities.modelsRefresh && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetryModels}>{t('external.retryModels')}</Button>}
    </div>}
    <div className="flex flex-wrap items-center gap-2" aria-label={t('external.nextRequest')}>
      <span className="text-muted-foreground">{t('external.nextRequest')}</span>
      <label className="inline-flex items-center gap-1">
        <span>{t('external.model')}</span>
        <select className={selectClass} aria-label={t('external.model')} disabled={disabled} value={choice.model || ''}
          onChange={event => onChange(externalModelChoice(choice, event.target.value, capabilities))}>
          <option value="">{t('external.inherit')}</option>
          {choice.model && !capabilities.models.some(model => model.id === choice.model) && <option value={choice.model}>{choice.model} · {t('external.notReported')}</option>}
          {capabilities.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {levels?.length ? <label className="inline-flex items-center gap-1">
        <span>{t('chat.context.thinking')}</span>
        <select className={selectClass} aria-label={t('chat.context.thinking')} disabled={disabled} value={choice.thinking || ''}
          onChange={event => onChange({ ...choice, thinking: event.target.value || undefined })}>
          <option value="">{t('external.inherit')}</option>
          {levels.map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      </label> : null}
      {capabilities.modes?.length ? <label className="inline-flex items-center gap-1">
        <span>{t('external.mode')}</span>
        <select className={selectClass} aria-label={t('external.mode')} disabled={disabled} value={choice.mode || ''}
          onChange={event => onChange({ ...choice, mode: event.target.value || undefined })}>
          <option value="">{t('external.inherit')}</option>
          {choice.mode && !capabilities.modes.some(mode => mode.id === choice.mode) && <option value={choice.mode}>{choice.mode} · {t('external.notReported')}</option>}
          {capabilities.modes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
        </select>
      </label> : null}
      {generic?.map(option => <label key={option.id} className="inline-flex items-center gap-1">
        <span>{option.name}</span>
        <select className={selectClass} aria-label={option.name} disabled={disabled} value={choice.config?.[option.id] === undefined ? '' : `value:${choice.config[option.id]}`}
          onChange={event => {
            const next = option.category === 'model' ? externalModelChoice(choice, choice.model ?? '', capabilities) : choice;
            const config = { ...next.config };
            if (!event.target.value) delete config[option.id]; else config[option.id] = event.target.value.slice(6);
            onChange({ ...next, config });
          }}>
          <option value="">{t('external.inherit')} · {String(option.currentValue)}</option>
          {(option.type === 'boolean' ? [{ value: 'true', name: t('external.yes') }, { value: 'false', name: t('external.no') }] : option.options)
            .map(value => <option key={value.value} value={`value:${value.value}`}>{value.name}</option>)}
        </select>
      </label>)}
    </div>
    {capabilities.commands?.length ? <details>
      <summary className="cursor-pointer text-muted-foreground">{t('external.commands')}</summary>
      <ul className="mt-2 space-y-1">
        {capabilities.commands.map(command => <li key={command.name} className="flex flex-wrap items-baseline gap-2">
          <button type="button" className="rounded px-1 font-mono text-primary hover:bg-muted disabled:opacity-50" disabled={disabled || !onCommand}
            onClick={() => onCommand?.(`/${command.name.replace(/^\//, '')} `)}>/{command.name.replace(/^\//, '')}</button>
          <span className="text-muted-foreground">{command.description}{command.inputHint ? ` · ${command.inputHint}` : ''}</span>
        </li>)}
      </ul>
    </details> : null}
  </div>;
}
