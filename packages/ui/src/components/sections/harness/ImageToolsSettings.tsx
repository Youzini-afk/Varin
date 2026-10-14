import React from 'react';
import type { ImageModelInfo } from '@varin/protocol';
import { runtimeFetch } from '@varin/application-client';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
const modelKey = (model: { providerId: string; modelId: string }) => JSON.stringify([model.providerId, model.modelId]);
export function ImageToolsSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const [models, setModels] = React.useState<ImageModelInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    void runtimeFetch('/api/images/models', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(t('settings.harness.images.unavailable'));
      const result = await response.json() as { models: ImageModelInfo[] };
      if (!controller.signal.aborted) setModels(result.models);
    }).catch(() => { if (!controller.signal.aborted) setError(t('settings.harness.images.unavailable')); });
    return () => controller.abort();
  }, [t]);
  return <SettingsSection title={t('settings.harness.images.title')} description={t('settings.harness.images.description')} settingsItem="harness.images" contentClassName="space-y-4">
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    {(['generation', 'editing'] as const).map(purpose => {
      const selected = harness.images?.[purpose];
      const available = models?.filter(model => purpose === 'generation' ? model.supportsGeneration : model.supportsEditing) ?? [];
      const current = selected ? available.find(model => modelKey(model) === modelKey(selected)) : undefined;
      return <SettingsFieldRow key={purpose} label={t(`settings.harness.images.${purpose}`)}>
        <div className="space-y-1.5">
          <Select value={selected ? modelKey(selected) : '__none__'} onValueChange={key => {
            const model = available.find(candidate => modelKey(candidate) === key);
            update({ images: { [purpose]: model ? { providerId: model.providerId, modelId: model.modelId } : null } });
          }}>
            <SelectTrigger size="settings" className="w-72" aria-label={t(`settings.harness.images.${purpose}`)}>
              <SelectValue>{selected ? current?.name ?? `${selected.providerId}/${selected.modelId}` : t('settings.harness.images.none')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('settings.harness.images.none')}</SelectItem>
              {selected && !current ? <SelectItem value={modelKey(selected)} disabled>{selected.providerId}/{selected.modelId}</SelectItem> : null}
              {available.map(model => <SelectItem key={modelKey(model)} value={modelKey(model)}>{model.name} · {model.providerId}</SelectItem>)}
            </SelectContent>
          </Select>
          {selected && models && !current ? <p className="typography-meta text-destructive">{t('settings.harness.images.modelUnavailable')}</p> : null}
        </div>
      </SettingsFieldRow>;
    })}
  </SettingsSection>;
}
