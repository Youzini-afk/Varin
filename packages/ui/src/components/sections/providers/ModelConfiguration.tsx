import React from 'react';
import { MODEL_THINKING_EFFORTS, modelThinkingConfiguration, modelThinkingLevels, type ChannelModel, type ChannelTypeInfo, type ModelConnectionTestResult, type ModelThinkingConfiguration, type ThreadThinkingLevel } from '@varin/application-client';
import { isModelThinkingConfiguration, type JsonValue } from '@varin/protocol';
import { SettingsSection, SettingsStackedField, SettingsFieldRow } from '../shared/SettingsSection';
import { JsonObjectField } from '../shared/JsonObjectField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface Props {
  model: ChannelModel; type: ChannelTypeInfo; busy: boolean; selected: boolean;
  onChange(model: ChannelModel): void;
  onRemove(): void;
  validity(field: string, valid: boolean): void;
  onTest(level: ThreadThinkingLevel, signal: AbortSignal): Promise<ModelConnectionTestResult>;
}
export function ModelConfiguration({ model, type, busy, selected, onChange, onRemove, validity, onTest }: Props) {
  const { t } = useI18n();
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ModelConnectionTestResult | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [previewLevel, setPreviewLevel] = React.useState<ThreadThinkingLevel>('off');
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    setResult(null); setFailure(null);
    return () => controller.current?.abort();
  }, [selected]);
  const disabled = busy || testing;
  const chat = model.operations.includes('chat');
  const levels = modelThinkingLevels(model);
  const level = levels.includes(previewLevel) ? previewLevel : levels[0] ?? 'off';
  const thinking = modelThinkingConfiguration(model);
  const budgetSupported = ['anthropic-messages', 'google-generative-ai', 'google-vertex', 'bedrock-converse-stream', 'openai-completions'].includes(type.protocol);
  const modes: ModelThinkingConfiguration['mode'][] = ['levels', 'switch', 'fixed', ...(budgetSupported ? ['budget' as const] : [])];
  const needsBudgetField = model.reasoning && thinking.mode === 'budget' && type.protocol === 'openai-completions' && model.compat?.thinkingFormat !== 'openrouter';
  const update = (patch: Partial<ChannelModel>) => { setResult(null); setFailure(null); onChange({ ...model, ...patch }); };
  const changeMode = (mode: ModelThinkingConfiguration['mode']) => update({ thinking: mode === 'levels' ? { mode, levels: [], allowOff: true } : mode === 'budget' ? { mode, tokens: 8192, allowOff: true } : { mode } });
  const invalidThinking = model.reasoning && thinking.mode === 'levels' && !thinking.levels.length;
  React.useEffect(() => { validity('thinking', !invalidThinking); }, [invalidThinking, validity]);
  const invalidCapacity = [model.contextWindow, model.maxOutputTokens].some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0));
  const invalidBudget = model.reasoning && thinking.mode === 'budget' && (!Number.isSafeInteger(thinking.tokens) || thinking.tokens <= 0 || needsBudgetField && typeof model.compat?.thinkingTokenBudgetField !== 'string');
  React.useEffect(() => { validity('capacity', !invalidCapacity); validity('budget', !invalidBudget); }, [invalidCapacity, invalidBudget, validity]);
  const test = async () => {
    const abort = new AbortController(); controller.current = abort;
    setTesting(true); setResult(null); setFailure(null);
    try { const value = await onTest(level, abort.signal); if (!abort.signal.aborted) setResult(value); }
    catch (error) { if (!abort.signal.aborted) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (controller.current === abort) { controller.current = null; setTesting(false); } }
  };
  return <div className="grid items-start gap-8 @4xl:grid-cols-[minmax(0,1fr)_260px]">
    <div className="min-w-0 @container">
      <SettingsSection title={t('settings.models.basic')} divider={false}>
        <SettingsFieldRow label={t('settings.models.name')} controlClassName="@xl:flex-1"><Input aria-label={t('settings.models.name')} value={model.name} disabled={disabled} onChange={event => update({ name: event.target.value })} /></SettingsFieldRow>
        <SettingsFieldRow label={t('settings.models.requestModelId')} controlClassName="@xl:flex-1"><Input aria-label={t('settings.models.requestModelId')} placeholder={model.id} value={model.requestModelId ?? ''} disabled={disabled} onChange={event => update({ requestModelId: event.target.value || undefined })} /></SettingsFieldRow>
        {type.operations.length > 1 ? <div className="flex flex-wrap gap-x-5 gap-y-3">{type.operations.map(operation => <label key={operation} className="flex items-center gap-2 typography-meta"><Checkbox checked={model.operations.includes(operation)} disabled={disabled} onChange={checked => update({ operations: checked ? [...model.operations, operation] : model.operations.filter(value => value !== operation) })} />{t(`settings.models.operation.${operation}`)}</label>)}</div> : null}
      </SettingsSection>
      {chat ? <>
        <SettingsSection title={t('settings.models.capabilities')}>
          <SettingsFieldRow label={t('settings.models.imageInput')} description={t('settings.models.imageInputHint')}><Switch aria-label={t('settings.models.imageInput')} checked={model.input?.includes('image') ?? false} disabled={disabled} onCheckedChange={enabled => update({ input: enabled ? ['text', 'image'] : ['text'] })} /></SettingsFieldRow>
          <SettingsFieldRow label={t('settings.models.reasoning')}><Switch aria-label={t('settings.models.reasoning')} checked={model.reasoning === true} disabled={disabled} onCheckedChange={enabled => update({ reasoning: enabled, ...(enabled && !model.thinking ? { thinking: { mode: 'switch' } } : !enabled && model.thinking && !isModelThinkingConfiguration(model.thinking) ? { thinking: undefined } : {}) })} /></SettingsFieldRow>
          {model.reasoning ? <div className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-4">
            <SettingsFieldRow label={t('settings.models.thinkingMode')}><Select value={thinking.mode} disabled={disabled} onValueChange={mode => changeMode(mode as ModelThinkingConfiguration['mode'])}><SelectTrigger size="settings" aria-label={t('settings.models.thinkingMode')}><SelectValue /></SelectTrigger><SelectContent>{modes.map(mode => <SelectItem key={mode} value={mode}>{t(`settings.models.thinkingMode.${mode}`)}</SelectItem>)}</SelectContent></Select></SettingsFieldRow>
            {thinking.mode === 'levels' ? <div><p className="mb-3 typography-meta">{t('settings.models.availableLevels')}</p><div className="flex flex-wrap gap-2">{MODEL_THINKING_EFFORTS.map(effort => <button key={effort} type="button" disabled={disabled} aria-pressed={thinking.levels.includes(effort)} onClick={() => update({ thinking: { ...thinking, levels: MODEL_THINKING_EFFORTS.filter(value => value === effort ? !thinking.levels.includes(value) : thinking.levels.includes(value)) } })} className={cn('rounded-lg border px-3 py-1.5 typography-meta transition-colors', thinking.levels.includes(effort) ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-interactive-hover')}>{t(`settings.agents.thinking.${effort}`)}</button>)}</div>{invalidThinking ? <p role="alert" className="mt-2 typography-micro text-destructive">{t('settings.models.chooseLevels')}</p> : null}</div> : null}
            {thinking.mode === 'budget' ? <SettingsFieldRow label={t('settings.models.thinkingTokens')}><Input type="number" aria-label={t('settings.models.thinkingTokens')} value={thinking.tokens} disabled={disabled} onChange={event => update({ thinking: { ...thinking, tokens: Number(event.target.value) } })} /></SettingsFieldRow> : null}
            {needsBudgetField ? <SettingsFieldRow label={t('settings.models.budgetField')}><Input aria-label={t('settings.models.budgetField')} value={String(model.compat?.thinkingTokenBudgetField ?? '')} placeholder="thinking_token_budget" disabled={disabled} onChange={event => { const compat = { ...model.compat }; if (event.target.value.trim()) compat.thinkingTokenBudgetField = event.target.value.trim(); else delete compat.thinkingTokenBudgetField; update({ compat }); }} /></SettingsFieldRow> : null}
            {invalidBudget ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.invalidBudget')}</p> : null}
            {thinking.mode === 'levels' || thinking.mode === 'budget' ? <label className="flex items-center gap-2 typography-meta"><Checkbox checked={thinking.allowOff} disabled={disabled} onChange={allowOff => update({ thinking: { ...thinking, allowOff } })} />{t('settings.models.allowOff')}</label> : null}
            {type.protocol === 'openai-completions' ? <SettingsFieldRow label={t('settings.models.thinkingFormat')}><Select value={String(model.compat?.thinkingFormat ?? 'standard')} disabled={disabled} onValueChange={value => { const compat = { ...model.compat }; if (value === 'standard') delete compat.thinkingFormat; else compat.thinkingFormat = value; update({ compat }); }}><SelectTrigger size="settings" aria-label={t('settings.models.thinkingFormat')}><SelectValue /></SelectTrigger><SelectContent>{['standard', 'deepseek', 'qwen', 'qwen-chat-template', 'openrouter', 'zai', 'together', 'ant-ling', 'string-thinking'].map(format => <SelectItem key={format} value={format}>{format === 'standard' ? 'reasoning_effort' : format}</SelectItem>)}</SelectContent></Select></SettingsFieldRow> : null}
          </div> : null}
        </SettingsSection>
        <SettingsSection title={t('settings.models.capacity')}>
          <div className="grid gap-4 @xl:grid-cols-2">{(['contextWindow', 'maxOutputTokens'] as const).map(field => <SettingsStackedField key={field} label={t(field === 'contextWindow' ? 'settings.models.context' : 'settings.models.output')}><Input type="number" aria-label={t(field === 'contextWindow' ? 'settings.models.context' : 'settings.models.output')} placeholder={t('settings.models.unspecified')} value={model[field] ?? ''} disabled={disabled} onChange={event => update({ [field]: event.target.value ? Number(event.target.value) : undefined })} /></SettingsStackedField>)}</div>
          {invalidCapacity ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.invalidCapacity')}</p> : null}
        </SettingsSection>
      </> : null}
      <SettingsSection title={t('settings.models.advanced')}>
        <details><summary className="cursor-pointer typography-meta text-muted-foreground">{t('settings.models.parameters')}</summary><div className="mt-4 space-y-4">{(['parameters', 'compat', 'thinkingLevelMap', 'image'] as const).map(field => <SettingsStackedField key={field} label={t(`settings.models.${field}`)} controlClassName="max-w-none"><JsonObjectField value={model[field] as Record<string, JsonValue> | undefined} label={t(`settings.models.${field}`)} disabled={disabled} onValidityChange={valid => validity(field, valid)} onChange={value => update({ [field]: value })} /></SettingsStackedField>)}</div></details>
        <Button variant="ghost" size="sm" className="text-destructive" disabled={disabled} onClick={onRemove}>{t('settings.models.removeModel')}</Button>
      </SettingsSection>
    </div>
    {chat ? <aside className="rounded-xl border border-border/60 bg-muted/15 p-5 @4xl:sticky @4xl:top-0">
      <h3 className="typography-ui-label">{t('settings.models.preview')}</h3>
      <div className="mt-4 rounded-xl border border-border/70 bg-background p-3"><div className="mb-6 typography-meta text-muted-foreground">{t('settings.models.previewPlaceholder')}</div><div className="flex flex-wrap items-center gap-2 typography-micro"><Icon name="add" className="size-4" /><span className="max-w-28 truncate">{model.name || model.id}</span>{model.reasoning ? <span className="rounded bg-muted px-1.5 py-0.5">{t(`settings.agents.thinking.${level}`)}</span> : null}<Icon name="arrow-up" className="ml-auto size-4 text-muted-foreground" /></div></div>
      {model.reasoning ? <div className="mt-4 flex flex-wrap gap-2">{levels.map(value => <button type="button" key={value} onClick={() => { setPreviewLevel(value); setResult(null); setFailure(null); }} disabled={testing} aria-pressed={level === value} className={cn('rounded-md px-2 py-1 typography-micro', level === value ? 'bg-foreground/10' : 'text-muted-foreground hover:bg-interactive-hover')}>{t(`settings.agents.thinking.${value}`)}</button>)}</div> : null}
      <div className="mt-4 space-y-2 typography-micro text-muted-foreground"><p>{t(model.input?.includes('image') ? 'settings.models.previewImages' : 'settings.models.previewText')}</p>{model.contextWindow ? <p>{t('settings.models.context')} · {model.contextWindow.toLocaleString()}</p> : null}{model.maxOutputTokens ? <p>{t('settings.models.output')} · {model.maxOutputTokens.toLocaleString()}</p> : null}</div>
      <div className="mt-5 border-t border-border/60 pt-4"><Button variant="outline" className="w-full" disabled={disabled || !!invalidThinking || invalidCapacity || !!invalidBudget} onClick={() => { void test(); }}>{testing ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="play" className="size-4" />}{t('settings.models.test')}</Button><p className="mt-2 typography-micro text-muted-foreground">{t('settings.models.testHint')}</p>
        {result ? <div role="status" className="mt-3 space-y-1 typography-meta"><p>{t('settings.models.testPassed')} · {(result.elapsedMs / 1000).toFixed(1)} s</p><p className="whitespace-pre-wrap break-words text-muted-foreground">{result.text}</p></div> : null}{failure ? <p role="alert" className="mt-3 break-words typography-meta text-destructive">{failure}</p> : null}
      </div>
    </aside> : null}
  </div>;
}
