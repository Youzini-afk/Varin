import { LinkRow, Row, Section, Sw, useSettingsShell } from '@/components/sections/shared/kit';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { ContextRecoverySettings } from './ContextRecoverySettings';
import { MessageTimeSettings } from './MessageTimeSettings';
import { ContextBudgetSettings } from './ContextBudgetSettings';

export function ContextSettings({ harness, update, reserveRatio, onReserveRatioChange }: HarnessSettingsPageProps & {
  reserveRatio: number;
  onReserveRatioChange(ratio: number): void;
}) {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const preparationLabel = t('settings.page.harness.context.backgroundPreparation');
  return <>
    <Section title={t('settings.contextScale.title')} item="harness.context">
      <Row label={preparationLabel} description={t('settings.page.harness.context.backgroundPreparation.description')}>
        <Sw label={preparationLabel} checked={harness.context.backgroundPreparation}
          onChange={backgroundPreparation => update({ context: { backgroundPreparation } })} />
      </Row>
      <ContextBudgetSettings reserveRatio={reserveRatio} preparationWaterline={harness.context.preparationWaterline}
        backgroundPreparation={harness.context.backgroundPreparation} onReserveRatioChange={onReserveRatioChange}
        onPreparationWaterlineChange={preparationWaterline => update({ context: { preparationWaterline } })} />
    </Section>
    <Section>
      <LinkRow item="harness.models.contextCompaction" label={t('settings.harness.role.contextCompaction')}
        description={t('settings.agents.context.configureDescription')}
        onClick={() => shell.openPage('agents', { item: 'harness.models.contextCompaction' })} />
    </Section>
    <Section>
      <ContextRecoverySettings value={harness.context.compactionRecovery} />
      <MessageTimeSettings harness={harness} update={update} />
    </Section>
  </>;
}
