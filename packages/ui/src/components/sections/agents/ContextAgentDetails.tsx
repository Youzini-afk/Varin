import React from 'react';
import type { ContextAgentDefinition } from '@varin/protocol';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsPageLink } from '@/components/sections/shared/SettingsPageLink';
import { useI18n } from '@/lib/i18n';

export function ContextAgentDetails({ definition, instructions }: { definition: ContextAgentDefinition; instructions: string }) {
  const { t } = useI18n();
  return <>
    <SettingsSection title={t('settings.agents.context.prompt')} contentClassName="space-y-3">
      <p className="typography-meta text-muted-foreground">{t('settings.agents.context.composition')}</p>
      <details className="typography-meta"><summary className="cursor-pointer">{t('settings.agents.context.system')}</summary>
        <pre className="mt-3 whitespace-pre-wrap break-words font-mono" data-context-system>{instructions}{'\n'}{definition.systemSuffix}</pre>
      </details>
      <details className="typography-meta"><summary className="cursor-pointer">{t('settings.agents.context.request')}</summary>
        <pre className="mt-3 whitespace-pre-wrap break-words font-mono">{definition.request}{'\n\n'}{definition.budgetTemplate}</pre>
        <p className="mt-3 text-muted-foreground">{t('settings.agents.context.dynamic')}</p>
      </details>
      <details className="typography-meta"><summary className="cursor-pointer">{t('settings.agents.context.tools')}</summary>
        {definition.tools.map(tool => <div key={tool.name} className="mt-3 space-y-2">
          <p className="font-mono">{tool.name}</p><p>{tool.description}</p>
          <pre className="whitespace-pre-wrap break-words font-mono">{JSON.stringify(tool.schema, null, 2)}</pre>
        </div>)}
      </details>
    </SettingsSection>
    <SettingsSection><SettingsPageLink page="harness-context" description={t('settings.agents.context.timingDescription')}>
      {t('settings.agents.context.timing')}
    </SettingsPageLink></SettingsSection>
  </>;
}
