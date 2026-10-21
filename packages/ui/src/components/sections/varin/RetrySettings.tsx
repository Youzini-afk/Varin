import React from 'react';
import { parseModelRetrySettings, type JsonValue, type ModelRetrySettings, type ModelRetryRule, type ModelRetryDecision } from '@varin/protocol';
import { createModelConnectionsHttpAPI } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '../shared/SettingsSection';

export function RetrySettings({ value, disabled, api, onSave }: {
  value: JsonValue | undefined;
  disabled: boolean;
  api: ReturnType<typeof createModelConnectionsHttpAPI>;
  onSave(value: Record<string, JsonValue>): Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<ModelRetrySettings>(() => parseModelRetrySettings(value));
  const [sample, setSample] = React.useState({ status: '503', code: '', message: '' });
  const [result, setResult] = React.useState<ModelRetryDecision>();
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const request = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => () => request.current?.abort(), []);
  const change = (patch: Partial<ModelRetrySettings>) => { request.current?.abort(); setBusy(false); setResult(undefined); setError(undefined); setDraft(old => ({ ...old, ...patch })); };
  const rule = (index: number, patch: Partial<ModelRetryRule>) => change({ rules: draft.rules.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const move = (index: number, delta: number) => {
    const rules = [...draft.rules];
    [rules[index], rules[index + delta]] = [rules[index + delta]!, rules[index]!];
    change({ rules });
  };
  const validate = async (save: boolean) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined); setResult(undefined);
    try {
      const settings = parseModelRetrySettings(draft);
      const status = sample.status.trim() ? Number(sample.status) : undefined;
      if (!save && status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error(t('settings.retry.invalidStatus'));
      const next = await api.testRetry(settings, save ? {} : { ...(status === undefined ? {} : { status }), code: sample.code, message: sample.message }, controller.signal);
      if (controller.signal.aborted) return;
      if (save) await onSave({ retry: settings as unknown as JsonValue }); else setResult(next);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const select = <T extends ModelRetryRule['field'] | ModelRetryRule['match'] | ModelRetryRule['action']>(selected: T, values: readonly T[], label: string, onChange: (value: T) => void) => <Select value={selected} disabled={disabled || busy} onValueChange={value => onChange(value as T)}>
    <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{values.map(value => <SelectItem key={value} value={value}>{t(`settings.retry.${value}`)}</SelectItem>)}</SelectContent>
  </Select>;
  return <SettingsSection title={t('settings.retry.title')} description={t('settings.retry.description')} settingsItem="sessions.retry">
    <SettingsCheckboxRow checked={draft.enabled} onChange={enabled => change({ enabled })} disabled={disabled || busy} label={t('settings.retry.enabled')} />
    {(['maxRetries', 'initialDelayMs', 'maxDelayMs'] as const).map(field => <SettingsFieldRow key={field} label={t(`settings.retry.${field}`)}>
      <Input type="number" min={0} step={1} value={draft[field]} aria-label={t(`settings.retry.${field}`)} disabled={disabled || busy} className="max-w-48 tabular-nums"
        onChange={event => change({ [field]: event.target.valueAsNumber })} />
    </SettingsFieldRow>)}
    <div className="mt-5 space-y-3">
      <div className="flex items-center justify-between gap-3"><span className="typography-settings-field-label">{t('settings.retry.rules')}</span>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => change({ rules: [...draft.rules, { field: 'message', match: 'contains', pattern: '', action: 'retry' }] })}>{t('settings.retry.add')}</Button></div>
      <p className="typography-meta text-muted-foreground">{t('settings.retry.rulesHelp')}</p>
      {draft.rules.map((item, index) => <div key={index} className="rounded-lg border border-border/60 p-3 space-y-2">
        <div className="flex items-center justify-between"><span className="typography-meta text-muted-foreground">{t('settings.retry.rule')} {index + 1}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" aria-label={t('settings.retry.up')} disabled={disabled || busy || index === 0} onClick={() => move(index, -1)}>↑</Button>
            <Button size="sm" variant="ghost" aria-label={t('settings.retry.down')} disabled={disabled || busy || index === draft.rules.length - 1} onClick={() => move(index, 1)}>↓</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => change({ rules: draft.rules.filter((_, i) => i !== index) })}>{t('settings.retry.remove')}</Button>
          </div></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {select(item.field, ['status', 'code', 'message'], t('settings.retry.field'), field => rule(index, { field }))}
          {select(item.match, ['exact', 'contains', 'regex'], t('settings.retry.match'), match => rule(index, { match }))}
          {select(item.action, ['retry', 'stop'], t('settings.retry.action'), action => rule(index, { action }))}
        </div>
        <Input value={item.pattern} disabled={disabled || busy} aria-label={t('settings.retry.pattern')} placeholder={item.match === 'regex' ? '^5[0-9]{2}$' : t('settings.retry.pattern')} onChange={event => rule(index, { pattern: event.target.value })} />
        {item.match === 'regex' && <p className="typography-meta text-muted-foreground">{t('settings.retry.regexHelp')}</p>}
      </div>)}
    </div>
    <details className="my-5 rounded-lg border border-border/60 p-3"><summary className="cursor-pointer typography-settings-field-label">{t('settings.retry.test')}</summary>
      <p className="my-3 typography-meta text-muted-foreground">{t('settings.retry.testHelp')}</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 typography-meta">{t('settings.retry.status')}<Input disabled={disabled || busy} value={sample.status} inputMode="numeric" onChange={event => { setSample({ ...sample, status: event.target.value }); setResult(undefined); }} /></label>
        <label className="space-y-1 typography-meta">{t('settings.retry.code')}<Input disabled={disabled || busy} value={sample.code} onChange={event => { setSample({ ...sample, code: event.target.value }); setResult(undefined); }} /></label>
      </div>
      <label className="my-3 block space-y-1 typography-meta">{t('settings.retry.message')}<Textarea disabled={disabled || busy} value={sample.message} rows={3} onChange={event => { setSample({ ...sample, message: event.target.value }); setResult(undefined); }} /></label>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void validate(false)}>{t('settings.retry.test')}</Button>
      {result && <p role="status" className="mt-3 typography-meta">{t(`settings.retry.${result.retry ? 'retry' : 'stop'}`)} · {result.ruleIndex === null ? t(`settings.retry.reason.${(['disabled', 'transient', 'exhausted', 'execution_stopped'] as const).find(reason => reason === result.reason) ?? 'unmatched'}`) : `${t('settings.retry.rule')} ${result.ruleIndex + 1}`}{result.retry ? ` · ${result.delayMs} ms` : ''}</p>}
    </details>
    {error && <p role="alert" className="mb-3 typography-meta text-destructive">{error}</p>}
    <Button disabled={disabled || busy || JSON.stringify(draft) === JSON.stringify(parseModelRetrySettings(value))} onClick={() => void validate(true)}>{t('settings.retry.save')}</Button>
  </SettingsSection>;
}
