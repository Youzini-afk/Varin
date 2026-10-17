import React from 'react';
import type { ChannelModel, ChannelTypeInfo, ModelConnectionOptions, ModelDecisionPaths } from '@varin/application-client';
import { SettingsSection, SettingsFieldRow } from '../shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

interface Props {
  model: ChannelModel;
  type: ChannelTypeInfo;
  disabled: boolean;
  inheritedImageApi?: string;
  inheritedDecisionApi?: string;
  inheritedPaths?: ModelConnectionOptions['paths'];
  onChange(patch: Partial<ChannelModel>): void;
}
const defaultImagePaths = (api: string) => api === 'openrouter-images'
  ? { generation: '/chat/completions', editing: '/chat/completions' }
  : { generation: '/images/generations', editing: '/images/edits' };
const defaultDecisionPaths = (api: string): ModelDecisionPaths => api === 'llama-cpp-classify'
  ? { tokenize: '/tokenize', applyTemplate: '/apply-template', completion: '/completion' }
  : { classify: api === 'cloudflare-workers-ai-system-one' ? '/run' : '/systemone' };

function RequestPathField({ label, value, disabled, onChange }: {
  label: string; value: string; disabled: boolean; onChange(value: string | undefined): void;
}) {
  return <SettingsFieldRow label={label} controlClassName="@xl:flex-1"><Input aria-label={label} value={value} disabled={disabled}
    onChange={event => onChange(event.target.value)}
    onBlur={event => { if (!event.currentTarget.value) onChange(undefined); }} /></SettingsFieldRow>;
}

export function ModelApiSettings({ model, type, disabled, inheritedImageApi, inheritedDecisionApi, inheritedPaths, onChange }: Props) {
  const { t } = useI18n();
  const imageApi = model.image?.api ?? inheritedImageApi ?? (type.id === 'openrouter' ? 'openrouter-images' : 'openai-images');
  const decisionApi = model.decision?.api ?? inheritedDecisionApi ?? type.defaultParameters?.decisionApi ?? type.protocol;
  const imagePaths = defaultImagePaths(imageApi);
  const decisionPaths = defaultDecisionPaths(String(decisionApi));
  const setImagePath = (key: 'generation' | 'editing', value: string | undefined) => {
    const paths = { ...model.image?.paths };
    if (value === undefined) delete paths[key]; else paths[key] = value;
    onChange({ image: { ...model.image, paths: Object.keys(paths).length ? paths : undefined } });
  };
  const setDecisionPath = (key: keyof ModelDecisionPaths, value: string | undefined) => {
    const paths = { ...model.decision?.paths };
    if (value === undefined) delete paths[key]; else paths[key] = value;
    onChange({ decision: { ...model.decision, paths: Object.keys(paths).length ? paths : undefined } });
  };
  return <>
    {model.operations.some(operation => operation === 'image-generation' || operation === 'image-editing') ? <SettingsSection title={t('settings.models.image')}>
      <SettingsFieldRow label={t('settings.models.parameter.imageApi')}><Select value={imageApi} disabled={disabled} onValueChange={api => {
        if (api === 'openai-images' || api === 'openrouter-images') onChange({ image: { ...model.image, api,
          paths: defaultImagePaths(api) } });
      }}><SelectTrigger size="settings" aria-label={t('settings.models.parameter.imageApi')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai-images">OpenAI Images</SelectItem><SelectItem value="openrouter-images">OpenRouter Images</SelectItem></SelectContent></Select></SettingsFieldRow>
      {model.operations.includes('image-generation') ? <RequestPathField label={t('settings.models.imageGenerationPath')}
        value={model.image?.paths?.generation ?? inheritedPaths?.['image-generation'] ?? imagePaths.generation} disabled={disabled} onChange={value => setImagePath('generation', value)} /> : null}
      {model.operations.includes('image-editing') ? <RequestPathField label={t('settings.models.imageEditingPath')}
        value={model.image?.paths?.editing ?? inheritedPaths?.['image-editing'] ?? imagePaths.editing} disabled={disabled} onChange={value => setImagePath('editing', value)} /> : null}
      <p className="typography-micro text-muted-foreground">{t('settings.models.apiPathsHint')}</p>
    </SettingsSection> : null}
    {model.operations.includes('decision') ? <SettingsSection title={t('settings.models.operation.decision')}>
      <SettingsFieldRow label={t('settings.models.parameter.decisionApi')}><Select value={String(decisionApi)} disabled={disabled} onValueChange={api => {
        if (api === 'typesafe-system-one' || api === 'cloudflare-workers-ai-system-one' || api === 'llama-cpp-classify') onChange({ decision: { ...model.decision, api,
          paths: defaultDecisionPaths(api) } });
      }}><SelectTrigger size="settings" aria-label={t('settings.models.parameter.decisionApi')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="typesafe-system-one">System One</SelectItem><SelectItem value="cloudflare-workers-ai-system-one">Cloudflare Workers AI System One</SelectItem><SelectItem value="llama-cpp-classify">llama.cpp</SelectItem></SelectContent></Select></SettingsFieldRow>
      {decisionApi === 'llama-cpp-classify' ? <>
        {(['tokenize', 'applyTemplate', 'completion'] as const).map(key => <RequestPathField key={key} label={t(`settings.models.${key}Path`)}
          value={model.decision?.paths?.[key] ?? decisionPaths[key]!} disabled={disabled} onChange={value => setDecisionPath(key, value)} />)}
        <p className="typography-micro text-muted-foreground">{t('settings.models.llamaPathsHint')}</p>
      </> : <>
        <RequestPathField label={t('settings.models.decisionPath')} value={model.decision?.paths?.classify ?? inheritedPaths?.decision ?? decisionPaths.classify!}
          disabled={disabled} onChange={value => setDecisionPath('classify', value)} />
        <p className="typography-micro text-muted-foreground">{t('settings.models.apiPathsHint')}</p>
      </>}
    </SettingsSection> : null}
  </>;
}
