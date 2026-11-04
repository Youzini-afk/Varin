import { resolveFastDecisionPurpose } from '@varin/protocol';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '../shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useConfigurationModels } from './ConfigurationModels';
import { HarnessModelField } from './HarnessModelField';
import type { HarnessSettingsPageProps } from './harness-settings-state';

function AssistanceModel({ harness, update, purpose, slot }: HarnessSettingsPageProps & {
  purpose: 'web-selection' | 'web-reading'; slot: 'webSelection' | 'reader';
}) {
  const { t } = useI18n();
  const catalog = useConfigurationModels();
  const explicit = harness.fastDecision?.purposes?.[purpose];
  const chat = harness.models[slot];
  const decision = resolveFastDecisionPurpose(harness.fastDecision, purpose);
  const useChat = (explicit === undefined || explicit === 'off') && chat?.enabled !== false && Boolean(chat?.providerId && chat.modelId);
  const selected = explicit && explicit !== 'off' ? JSON.stringify([explicit.providerId, explicit.modelId])
    : useChat || explicit === 'off' ? 'chat' : 'default';
  const unavailable = explicit && explicit !== 'off'
    && !catalog.modelsFor(explicit.providerId, 'decision').some(model => model.id === explicit.modelId);
  const label = t(purpose === 'web-selection' ? 'settings.page.harness.web.assistance.selection' : 'settings.page.harness.web.assistance.reading');
  return <div className="space-y-3">
    <SettingsFieldRow label={label} description={t('settings.page.harness.web.assistance.model.description')}>
      <Select value={selected} onValueChange={value => {
        if (value === 'chat') update({ models: { [slot]: { enabled: true } }, fastDecision: { purposes: { [purpose]: 'off' } } });
        else if (value === 'default') update({ models: { [slot]: { enabled: false } }, fastDecision: { purposes: { [purpose]: undefined } } });
        else {
          const [providerId, modelId] = JSON.parse(value) as [string, string];
          update({ fastDecision: { purposes: { [purpose]: { protocol: 'typed-classifier', providerId, modelId, endpoint: undefined } } } });
        }
      }}>
        <SelectTrigger size="settings" className="w-72" aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="chat">{t('settings.page.harness.web.assistance.chat')}</SelectItem>
          <SelectItem value="default">{t('settings.page.harness.web.assistance.defaultDecision')}</SelectItem>
          {unavailable && explicit ? <SelectItem value={selected} disabled>{explicit.modelId} · {explicit.providerId}</SelectItem> : null}
          {catalog.providers.flatMap(provider => catalog.modelsFor(provider.id, 'decision').map(model => <SelectItem
            key={JSON.stringify([provider.id, model.id])} value={JSON.stringify([provider.id, model.id])}>
            {model.name || model.id} · {provider.name}
          </SelectItem>))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    {selected === 'chat' ? <HarnessModelField harness={harness} update={update} slot={slot} enableControl={false} />
      : decision.status !== 'ready' ? <p className="typography-meta text-muted-foreground">{t('settings.page.harness.web.assistance.unconfigured')}</p> : null}
    {unavailable ? <p role="alert" className="typography-meta text-muted-foreground">{t('settings.delegationModelSelection.unavailable')}</p> : null}
    {catalog.error ? <p role="alert" className="typography-meta text-destructive">{catalog.error}</p> : null}
  </div>;
}

/** The switch changes optional assistance only, never basic source retrieval or original text. */
export function WebAssistanceSettings(props: HarnessSettingsPageProps) {
  const { t } = useI18n();
  return <SettingsSection title={t('settings.page.harness.web.assistance.title')}
    description={t('settings.page.harness.web.assistance.description')} settingsItem="harness.web.assistance" contentClassName="space-y-5">
    <AssistanceModel {...props} purpose="web-selection" slot="webSelection" />
    <SettingsCheckboxRow checked={props.harness.web?.readingAssistance === true}
      onChange={readingAssistance => props.update({ web: { readingAssistance } })}
      label={t('settings.page.harness.web.assistance.readingEnabled')} ariaLabel={t('settings.page.harness.web.assistance.readingEnabled')} />
    <AssistanceModel {...props} purpose="web-reading" slot="reader" />
  </SettingsSection>;
}
