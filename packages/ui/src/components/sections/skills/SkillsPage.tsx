import React from 'react';
import { NativeResourcePage } from '@/components/sections/resources/NativeResourcePage';
import { NativeResourceSidebar } from '@/components/sections/resources/NativeResourceSidebar';
import { CommandsPage } from '@/components/sections/commands/CommandsPage';
import { Av, CatalogItem, Ic, useSettingsShell } from '@/components/sections/shared/kit';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { useI18n } from '@/lib/i18n';

export function SkillsPage() {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const [commands, setCommands] = React.useState(false);
  const select = (showCommands: boolean) => { setCommands(showCommands); shell.setCatalogStage('detail'); };
  return <div className="sk-cat" data-mstage={shell.catalogStage}>
    <aside className="sk-cat-list">
      <NativeResourceSidebar kind="skill" showPinned={commands} onItemSelect={() => select(false)}
        pinned={<CatalogItem pinned selected={commands} name={t('settings.commands.sidebar.title')}
          lead={<Av><Ic name="terminal" size="sm" /></Av>} onSelect={() => requestSettingsNavigation(() => select(true))} />} />
    </aside>
    <section className="sk-cat-detail">{commands ? <CommandsPage /> : <NativeResourcePage kind="skill" />}</section>
  </div>;
}
