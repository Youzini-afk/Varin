import React from 'react';
import type { ChannelModel, ModelPricing } from '@varin/application-client';
import { SettingsFieldRow, SettingsSection } from '../shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

const fields = [['inputPerMillion', 'usage.input'], ['cacheReadPerMillion', 'usage.cacheRead'], ['cacheWritePerMillion', 'usage.cacheWrite'], ['outputPerMillion', 'usage.output'], ['reasoningPerMillion', 'usage.reasoning']] as const;
type Tier = NonNullable<ModelPricing['longContext']>;
export function ModelPricingSettings({ model, disabled, onChange, validity }: { model: ChannelModel; disabled: boolean; onChange(patch: Partial<ChannelModel>): void; validity(field: string, valid: boolean): void }) {
  const { t } = useI18n();
  const tiers = [...(model.pricing?.contextTiers ?? []), ...(model.pricing?.longContext ? [model.pricing.longContext] : [])];
  const invalid = fields.some(([field]) => model.pricing?.[field] !== undefined && (!Number.isFinite(model.pricing[field]) || model.pricing[field]! < 0))
    || tiers.some(tier => !Number.isSafeInteger(tier.aboveInputTokens) || tier.aboveInputTokens <= 0 || fields.slice(0, 4).some(([field]) => field in tier && (!Number.isFinite(tier[field as keyof Tier]) || Number(tier[field as keyof Tier]) < 0)))
    || new Set(tiers.map(tier => tier.aboveInputTokens)).size !== tiers.length;
  React.useEffect(() => { validity('pricing', !invalid); }, [invalid, validity]);
  const change = (key: typeof fields[number][0], text: string) => {
    const pricing: ModelPricing = { ...model.pricing };
    if (text === '') delete pricing[key]; else pricing[key] = Number(text);
    onChange({ pricing });
  };
  const changeTiers = (values: Tier[]) => onChange({ pricing: { ...model.pricing, longContext: undefined, contextTiers: values.length ? values : undefined } });
  return <SettingsSection title={t('usage.pricingSection')} description={t('usage.pricingDescription')}>
    <SettingsFieldRow label={t('usage.billing')}><Select disabled={disabled} value={model.billing ?? 'auto'} onValueChange={value => onChange({ billing: value === 'auto' ? undefined : value as ChannelModel['billing'] })}>
      <SelectTrigger size="settings" aria-label={t('usage.billing')}><SelectValue /></SelectTrigger><SelectContent>
        {(['auto', 'metered', 'subscription', 'local'] as const).map(value => <SelectItem key={value} value={value}>{t(value === 'auto' ? 'usage.automatic' : `usage.${value}`)}</SelectItem>)}
      </SelectContent></Select></SettingsFieldRow>
    <div className="grid gap-x-7 @2xl:grid-cols-2">{fields.map(([key, label]) => <SettingsFieldRow key={key} label={t(label)}><Input type="number" min="0" step="any" className="w-32 tabular-nums" disabled={disabled} aria-label={`${t(label)} USD`} placeholder="—" value={model.pricing?.[key] ?? ''} onChange={event => change(key, event.target.value)} /></SettingsFieldRow>)}</div>
    {tiers.map((tier, index) => <div key={index} className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs"><span>{t('usage.longContext')}</span><Button variant="ghost" size="sm" disabled={disabled} onClick={() => changeTiers(tiers.filter((_, position) => position !== index))}>{t('usage.removeTier')}</Button></div>
      <p className="mb-3 text-xs text-muted-foreground">{t('usage.tierHint')}</p>
      <div className="grid gap-x-7 @2xl:grid-cols-2"><SettingsFieldRow label={t('usage.threshold')}><Input type="number" min="1" step="1" className="w-32" value={tier.aboveInputTokens} disabled={disabled} aria-label={`${t('usage.threshold')} ${index + 1}`} onChange={event => changeTiers(tiers.map((value, position) => position === index ? { ...value, aboveInputTokens: event.currentTarget.valueAsNumber } : value))} /></SettingsFieldRow>
        {fields.slice(0, 4).map(([key, label]) => <SettingsFieldRow key={key} label={t(label)}><Input type="number" min="0" step="any" className="w-32" disabled={disabled} aria-label={`${t('usage.longContext')} ${index + 1} ${t(label)} USD`} placeholder="—" value={tier[key as keyof Tier] ?? ''} onChange={event => {
          const next = { ...tier }; if (event.target.value === '') Reflect.deleteProperty(next, key); else Object.assign(next, { [key]: event.currentTarget.valueAsNumber });
          changeTiers(tiers.map((value, position) => position === index ? next : value));
        }} /></SettingsFieldRow>)}</div>
    </div>)}
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => changeTiers([...tiers, { aboveInputTokens: tiers.length ? Math.max(...tiers.map(tier => tier.aboveInputTokens)) * 2 : 200_000 }])}>{t('usage.addTier')}</Button>
    {invalid && <p role="alert" className="text-xs text-destructive">{t('usage.invalidPrice')}</p>}
  </SettingsSection>;
}
