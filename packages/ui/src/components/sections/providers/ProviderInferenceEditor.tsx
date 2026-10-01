import React from 'react';
import { PROVIDER_INFERENCE_CAPABILITIES, type ProviderInferenceCapability } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { createEmptyCustomProviderModel, type CustomProviderInferenceForm } from './customProviderForm';

export function ProviderInferenceEditor({ value, onChange }: {
  value: Record<ProviderInferenceCapability, CustomProviderInferenceForm>;
  onChange: (kind: ProviderInferenceCapability, patch: Partial<CustomProviderInferenceForm>) => void;
}) {
  const { t } = useI18n();
  const providers = usePiProviderStore(state => state.allProviders);
  const credentialListId = React.useId();
  const protocols = {
    embedding: 'OpenAI-compatible Embeddings', rerank: 'HTTP Rerank', decision: 'TypeSafe System One',
  } as const;
  return <div className="space-y-4">
    <datalist id={credentialListId}>{providers.map(provider => <option key={provider.id} value={provider.id} />)}</datalist>
    {PROVIDER_INFERENCE_CAPABILITIES.map(kind => {
      const capability = value[kind];
      const label = t(`settings.providers.page.custom.capability.${kind}`);
      const patchModel = (index: number, field: 'id' | 'name', text: string) => onChange(kind, {
        models: capability.models.map((model, row) => row === index ? { ...model, [field]: text } : model),
      });
      return <section key={kind} className="rounded-lg border border-[var(--surface-subtle)] p-3 space-y-3">
        <label className="flex items-center gap-2 typography-ui-label">
          <Checkbox checked={capability.enabled} onChange={enabled => onChange(kind, { enabled, disabled: !enabled })} ariaLabel={label} />
          {label}
        </label>
        {capability.enabled && <>
          <div className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.field.type')}: {protocols[kind]}</div>
          {kind === 'decision' && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.capability.decisionTasks')}</p>}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1.5 typography-meta text-muted-foreground">
              <span>{t('settings.providers.page.custom.field.baseURL')}</span>
              <Input value={capability.baseURL} onChange={event => onChange(kind, { baseURL: event.target.value })}
                placeholder={t('settings.providers.page.custom.capability.inheritAddress')} className="h-7" />
            </label>
            <label className="space-y-1.5 typography-meta text-muted-foreground">
              <span>{t('settings.providers.page.custom.capability.endpoint')}</span>
              <Input value={capability.endpoint} onChange={event => onChange(kind, { endpoint: event.target.value })}
                placeholder={kind === 'embedding' ? '/embeddings' : kind === 'rerank' ? '/rerank' : '/v1/systemone'} className="h-7" />
            </label>
            <label className="space-y-1.5 typography-meta text-muted-foreground md:col-span-2">
              <span>{t('settings.providers.page.custom.capability.credentialRef')}</span>
              <Input value={capability.credentialRef} onChange={event => onChange(kind, { credentialRef: event.target.value })}
                list={credentialListId} placeholder={t('settings.providers.page.custom.capability.inheritCredential')} className="h-7" />
            </label>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="typography-ui-label">{t('settings.providers.page.custom.field.models')}</span>
              <Button size="xs" variant="outline" onClick={() => onChange(kind, { models: [...capability.models, createEmptyCustomProviderModel()] })}>
                {t('settings.providers.page.actions.addModel')}
              </Button>
            </div>
            {capability.models.map((model, index) => <div key={index} className="flex flex-wrap items-center gap-2">
              <Input value={model.id} onChange={event => patchModel(index, 'id', event.target.value)} className="h-7 flex-1"
                aria-label={t('settings.providers.page.custom.placeholder.modelId')} placeholder={kind === 'decision' ? 'jev-1.13' : t('settings.providers.page.custom.placeholder.modelId')} />
              <Input value={model.name} onChange={event => patchModel(index, 'name', event.target.value)} className="h-7 flex-1"
                aria-label={t('settings.providers.page.custom.placeholder.modelName')} placeholder={t('settings.providers.page.custom.placeholder.modelName')} />
              <Button size="xs" variant="ghost" onClick={() => onChange(kind, { models: capability.models.filter((_, row) => row !== index) })}>
                {t('settings.providers.page.actions.removeModel')}
              </Button>
            </div>)}
            <p className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.capability.manualModels')}</p>
          </div>
        </>}
      </section>;
    })}
  </div>;
}
