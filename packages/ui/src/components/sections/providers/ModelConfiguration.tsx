import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { modelThinkingConfiguration, modelThinkingLevels, type ChannelModel, type ChannelTypeInfo, type ModelCatalogField, type ModelConnectionOptions, type ModelConnectionTestResult, type ModelThinkingConfiguration, type ThreadThinkingLevel } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';
import { SettingsSection, SettingsStackedField, SettingsFieldRow } from '../shared/SettingsSection';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ModelCommonSettings } from './ModelCommonSettings';
import { ModelApiSettings } from './ModelApiSettings';
import { ModelTokenizerSettings } from './ModelTokenizerSettings';
import { ModelPricingSettings } from './ModelPricingSettings';
import { ModelAutoSaveField } from './ModelAutoSaveField';
import { ModelFieldContext } from './model-field-context';
import { ModelFieldLabel } from './ModelFieldStatus';
import './model-connections.css';

interface Props {
  model: ChannelModel; type: ChannelTypeInfo; defaults?: ChannelModel;
  reset?: number;
  inheritedImageApi?: string; inheritedDecisionApi?: string; inheritedPaths?: ModelConnectionOptions['paths'];
  onChange(patch: Partial<ChannelModel>): void;
  onFollow(field: ModelCatalogField): void; onRemove(): void;
  onTest(level: ThreadThinkingLevel, signal: AbortSignal): Promise<ModelConnectionTestResult>;
}

export function ModelConfigurationDrawer({ open, onOpenChange, ...props }: Props & { open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useI18n();
  const descriptionRef = React.useRef<HTMLDivElement>(null);
  return <Dialog.Root open={open} onOpenChange={value => {
    if (!value && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    onOpenChange(value);
  }}>
    <Dialog.Portal>
      {/* Settings is itself a dialog. Keep an owning backdrop above it for outside dismissal. */}
      <Dialog.Backdrop forceRender className="motion-dialog-backdrop fixed inset-0 z-50 bg-black/30 dark:bg-black/55" />
      <Dialog.Popup data-slot="dialog-content" className="model-configuration-drawer fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col border-l border-border bg-background text-foreground shadow-xl"
        initialFocus={() => descriptionRef.current?.querySelector('textarea') ?? false}>
        <Dialog.Close render={<Button variant="ghost" size="icon" className="absolute top-4 right-4 z-10" aria-label={t('settings.models.close')} />}><Icon name="close" className="size-4" /></Dialog.Close>
        <ModelConfiguration key={props.reset} {...props} descriptionRef={descriptionRef} />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Invalid multi-control combinations remain local until the model is coherent again. */
function ModelConfiguration({ model: saved, type, defaults, inheritedImageApi, inheritedDecisionApi, inheritedPaths, onChange, onFollow, onRemove, onTest, descriptionRef }: Props & { descriptionRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useI18n();
  const [model, setModel] = React.useState(saved);
  const local = React.useRef(saved);
  const unsaved = React.useRef<Partial<ChannelModel>>({});
  const [restored, setRestored] = React.useState<Partial<Record<ModelCatalogField, number>>>({});
  React.useEffect(() => { local.current = { ...saved, ...unsaved.current }; setModel(local.current); }, [saved]);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ModelConnectionTestResult | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [levelChoice, setLevelChoice] = React.useState<ThreadThinkingLevel>('off');
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  const chat = model.operations.includes('chat');
  const levels = modelThinkingLevels(model);
  const level = levels.includes(levelChoice) ? levelChoice : levels[0] ?? 'off';
  const thinking = modelThinkingConfiguration(model);
  const protocol = model.protocol ?? type.protocol;
  const budgetSupported = ['anthropic-messages', 'google-generative-ai', 'google-vertex', 'bedrock-converse-stream', 'openai-completions'].includes(protocol)
    && !(protocol === 'anthropic-messages' && (model.compat?.forceAdaptiveThinking === true || model.compat?.supportsMidConvoEffort === true));
  const modes: ModelThinkingConfiguration['mode'][] = ['levels', 'switch', 'fixed', ...(budgetSupported ? ['budget' as const] : [])];
  const needsBudgetField = model.reasoning && thinking.mode === 'budget' && protocol === 'openai-completions' && model.compat?.thinkingFormat !== 'openrouter';
  const valid = (value: ChannelModel) => {
    const configuration = modelThinkingConfiguration(value);
    const chat = value.operations.includes('chat');
    const protocol = value.protocol ?? type.protocol;
    const tokenizer = value.tokenizer;
    const tokenizerValue = tokenizer?.kind === 'encoding' ? tokenizer.name : tokenizer?.kind === 'huggingface' ? tokenizer.repository : tokenizer?.kind === 'url' ? tokenizer.url : tokenizer?.kind === 'file' ? tokenizer.path : undefined;
    return (!tokenizer || Boolean(tokenizerValue?.trim())) && value.operations.length > 0 && !(chat && value.reasoning && (configuration.mode === 'levels' && !configuration.levels.length
      || configuration.mode === 'budget' && (!Number.isSafeInteger(configuration.tokens) || configuration.tokens <= 0
        || protocol === 'openai-completions' && value.compat?.thinkingFormat !== 'openrouter' && !value.compat?.thinkingTokenBudgetField)));
  };
  const update = (patch: Partial<ChannelModel>) => {
    const next = { ...local.current, ...patch };
    local.current = next; setModel(next); setResult(null); setFailure(null);
    unsaved.current = { ...unsaved.current, ...patch };
    if (valid(next)) { const commit = unsaved.current; unsaved.current = {}; onChange(commit); }
    else if (valid({ ...saved, ...patch })) {
      // An unfinished thinking/tokenizer edit does not hold unrelated model fields hostage.
      for (const key of Object.keys(patch) as (keyof ChannelModel)[]) delete unsaved.current[key];
      onChange(patch);
    }
  };
  const changeOperation = (operation: ChannelModel['operations'][number], checked: boolean) => {
    const operations = checked ? [...model.operations, operation] : model.operations.filter(value => value !== operation);
    update({ operations, ...(!operations.includes('decision') ? { decision: undefined } : {}),
      ...(!operations.some(value => value === 'image-generation' || value === 'image-editing') ? { image: undefined } : {}) });
  };
  const changeMode = (mode: ModelThinkingConfiguration['mode']) => update({ thinking: mode === 'levels' ? { mode, levels: [], allowOff: true } : mode === 'budget' ? { mode, tokens: 8192, allowOff: true } : { mode } });
  const test = async () => {
    const abort = new AbortController(); controller.current = abort;
    setTesting(true); setResult(null); setFailure(null);
    try { const value = await onTest(level, abort.signal); if (!abort.signal.aborted) setResult(value); }
    catch (cause) { if (!abort.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (controller.current === abort) { controller.current = null; setTesting(false); } }
  };
  return <ModelFieldContext.Provider value={{ model, defaults, restored, onFollow: field => {
    delete unsaved.current[field]; setResult(null); setFailure(null);
    setRestored(previous => ({ ...previous, [field]: (previous[field] ?? 0) + 1 }));
    onFollow(field);
  } }}>
    <header className="shrink-0 space-y-4 border-b border-border/60 px-6 pt-6 pb-5">
      <div className="flex items-start gap-3 pr-9"><ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} className="mt-1 size-6 shrink-0" /><div className="min-w-0 flex-1"><Dialog.Title className="break-words typography-ui-label">{model.name || model.id}</Dialog.Title><p className="mt-1 break-all typography-micro text-muted-foreground">{model.id}</p></div><Switch aria-label={`${t('settings.models.enabled')}: ${model.name || model.id}`} checked={model.enabled} onCheckedChange={enabled => update({ enabled })} /></div>
      {chat ? <><div className="flex flex-wrap items-center gap-2">{model.reasoning ? levels.map(value => <button type="button" key={value} onClick={() => { setLevelChoice(value); setResult(null); setFailure(null); }} disabled={testing} aria-pressed={level === value} className={cn('rounded-md px-2 py-1 typography-micro transition-colors', level === value ? 'bg-foreground/10' : 'text-muted-foreground hover:bg-interactive-hover')}>{t(`settings.agents.thinking.${value}`)}</button>) : null}<Button variant="outline" size="sm" disabled={testing || !valid(model)} onClick={() => { void test(); }}>{testing ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="play" className="size-3.5" />}{t('settings.models.test')}</Button></div><p className="typography-micro text-muted-foreground">{t('settings.models.testHint')}</p></> : null}
      {result ? <div role="status" className="space-y-1 typography-meta"><p>{t('settings.models.testPassed')} · {(result.elapsedMs / 1000).toFixed(1)} s</p><p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">{result.text}</p></div> : null}{failure ? <p role="alert" className="break-words typography-meta text-destructive">{failure}</p> : null}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 @container">
      <div ref={descriptionRef}><SettingsSection divider={false} className="pt-5" title={<ModelFieldLabel field="description">{t('settings.models.modelDescription')}</ModelFieldLabel>}>
        <ModelAutoSaveField catalogField="description" multiline rows={4} aria-label={t('settings.models.modelDescription')} value={model.description ?? ''} onCommit={description => update({ description })} />
        <p className="mt-2 typography-micro text-muted-foreground">{t('settings.models.descriptionDispatchHint')}</p>
      </SettingsSection></div>
      <SettingsSection title={t('settings.models.basic')}>
        <SettingsFieldRow label={<ModelFieldLabel field="name">{t('settings.models.name')}</ModelFieldLabel>}><ModelAutoSaveField catalogField="name" aria-label={t('settings.models.name')} value={model.name} onCommit={name => update({ name })} validate={value => value.trim() ? null : t('settings.models.requiredValue')} /></SettingsFieldRow>
        <SettingsFieldRow label={<ModelFieldLabel field="requestModelId">{t('settings.models.requestModelId')}</ModelFieldLabel>}><ModelAutoSaveField catalogField="requestModelId" aria-label={t('settings.models.requestModelId')} placeholder={model.id} value={model.requestModelId ?? ''} onCommit={requestModelId => update({ requestModelId: requestModelId || undefined })} /></SettingsFieldRow>
        {type.operations.length > 1 ? <div className="space-y-3"><ModelFieldLabel field="operations">{t('settings.models.capabilities')}</ModelFieldLabel><div className="flex flex-wrap gap-x-5 gap-y-3">{type.operations.map(operation => <label key={operation} className="flex items-center gap-2 typography-meta"><Checkbox ariaLabel={t(`settings.models.operation.${operation}`)} checked={model.operations.includes(operation)} onChange={checked => changeOperation(operation, checked)} />{t(`settings.models.operation.${operation}`)}</label>)}</div>{!model.operations.length ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.chooseOperation')}</p> : null}</div> : null}
      </SettingsSection>
      {chat ? <SettingsSection title={t('settings.models.capabilitiesThinking')}>
        <ModelCommonSettings model={model} group="capabilities" disabled={false} onChange={update}>
          <SettingsFieldRow label={<ModelFieldLabel field="thinking">{t('settings.models.thinkingMode')}</ModelFieldLabel>}><Select value={thinking.mode} onValueChange={mode => changeMode(mode as ModelThinkingConfiguration['mode'])}><SelectTrigger size="settings" aria-label={t('settings.models.thinkingMode')}><SelectValue /></SelectTrigger><SelectContent>{modes.map(mode => <SelectItem key={mode} value={mode}>{t(`settings.models.thinkingMode.${mode}`)}</SelectItem>)}</SelectContent></Select></SettingsFieldRow>
          {protocol === 'openai-completions' ? <SettingsFieldRow label={<ModelFieldLabel field="compat">{t('settings.models.thinkingFormat')}</ModelFieldLabel>}><Select value={String(model.compat?.thinkingFormat ?? 'standard')} onValueChange={value => { const compat = { ...model.compat }; if (value === 'standard') delete compat.thinkingFormat; else compat.thinkingFormat = value; update({ compat }); }}><SelectTrigger size="settings" aria-label={t('settings.models.thinkingFormat')}><SelectValue /></SelectTrigger><SelectContent>{['standard', 'deepseek', 'qwen', 'qwen-chat-template', 'openrouter', 'zai', 'together', 'ant-ling', 'string-thinking'].map(format => <SelectItem key={format} value={format}>{format === 'standard' ? 'reasoning_effort' : format}</SelectItem>)}</SelectContent></Select></SettingsFieldRow> : null}
          {needsBudgetField ? <SettingsFieldRow label={<ModelFieldLabel field="compat">{t('settings.models.budgetField')}</ModelFieldLabel>}><ModelAutoSaveField catalogField="compat" aria-label={t('settings.models.budgetField')} value={String(model.compat?.thinkingTokenBudgetField ?? '')} placeholder="thinking_token_budget" validate={value => value.trim() ? null : t('settings.models.invalidBudget')} onCommit={value => update({ compat: { ...local.current.compat, thinkingTokenBudgetField: value.trim() } })} /></SettingsFieldRow> : null}
        </ModelCommonSettings>
      </SettingsSection> : null}
      <SettingsSection title={t('settings.models.capacity')}><ModelCommonSettings model={model} group="capacity" disabled={false} onChange={update} /></SettingsSection>
      <ModelPricingSettings model={model} disabled={false} onChange={update} />
      <SettingsSection title={t('settings.models.interface')}>
        <ModelApiSettings model={model} type={type} disabled={false} inheritedImageApi={inheritedImageApi} inheritedDecisionApi={inheritedDecisionApi} inheritedPaths={inheritedPaths} onChange={update} />
        {chat && (type.protocols?.length ?? 0) > 1 ? <SettingsFieldRow label={<ModelFieldLabel field="protocol">{t('settings.models.protocol')}</ModelFieldLabel>}><Select value={protocol} onValueChange={value => update({ protocol: value })}><SelectTrigger size="settings" aria-label={t('settings.models.protocol')}><SelectValue /></SelectTrigger><SelectContent>{type.protocols!.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></SettingsFieldRow> : null}
        {chat ? <ModelTokenizerSettings model={model} disabled={false} onChange={update} /> : null}
      </SettingsSection>
      <SettingsDisclosure title={t('settings.models.rawParameters')}>
        {(['parameters', 'compat', 'thinkingLevelMap', 'image'] as const).map(field => <SettingsStackedField key={field} label={<ModelFieldLabel field={field}>{t(`settings.models.${field}`)}</ModelFieldLabel>} controlClassName="max-w-none">
          <ModelAutoSaveField catalogField={field} multiline rows={4} className="font-mono typography-micro" value={model[field] === undefined ? '' : JSON.stringify(model[field], null, 2)} aria-label={t(`settings.models.${field}`)} validate={value => {
            if (!value.trim()) return null;
            try { const object = JSON.parse(value); return object && typeof object === 'object' && !Array.isArray(object) ? null : t('settings.models.invalidObject'); } catch { return t('settings.models.invalidObject'); }
          }} onCommit={value => update({ [field]: value.trim() ? JSON.parse(value) as Record<string, JsonValue> : undefined })} />
        </SettingsStackedField>)}
      </SettingsDisclosure>
      <div className="mt-5 border-t border-border/60 pt-4"><Button variant="ghost" size="sm" className="text-destructive" onClick={() => { if (window.confirm(t('settings.models.removeModelConfirm'))) onRemove(); }}>{t('settings.models.removeModel')}</Button></div>
    </div>
  </ModelFieldContext.Provider>;
}
