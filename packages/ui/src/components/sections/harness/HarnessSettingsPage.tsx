import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useHarnessSettings } from './useHarnessSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { ToolsSettings } from './ToolsSettings';
import { PermissionsSettings } from './PermissionsSettings';
import { ModelsSettings } from './ModelsSettings';
import { ContextSettings } from './ContextSettings';
import { RetrievalSettings } from './RetrievalSettings';
import { IndexSettings } from './IndexSettings';
import { WebSettings } from './WebSettings';
import { KnowledgeSettings } from '../knowledge/KnowledgeSettings';
import { ComputerSettings } from '../computers/ComputerSettings';
import { BotSettings } from '../bots/BotSettings';
import { useSettingsSearchTarget } from '@/lib/settings/search-target';
import { cn } from '@/lib/utils';

export type HarnessSettingsSection = 'tools' | 'permissions' | 'models' | 'context' | 'retrieval' | 'index' | 'web' | 'computers' | 'bots';
const pages: Record<HarnessSettingsSection, React.ComponentType<HarnessSettingsPageProps>> = {
  tools: ToolsSettings, permissions: PermissionsSettings, models: ModelsSettings,
  context: ContextSettings, retrieval: RetrievalSettings, index: IndexSettings, web: WebSettings,
  // Self-fetching: the computer and bot catalogs come from the Host service,
  // not harness settings — extra props are ignored.
  computers: ComputerSettings, bots: BotSettings };

export function HarnessSettingsPage({ section }: { section: HarnessSettingsSection }) {
  const { t } = useI18n();
  const { harness, status, error, update, retry, targetKey } = useHarnessSettings();
  const searchTarget = useSettingsSearchTarget();
  const [tab, setTab] = React.useState<'context' | 'knowledge'>('context');
  const [knowledgeVisited, setKnowledgeVisited] = React.useState(false);
  const tabsId = React.useId();
  const combined = section === 'context';
  const searchTab = searchTarget?.startsWith('knowledge.') ? 'knowledge'
    : searchTarget === 'harness.context' ? 'context' : null;
  const activeTab = searchTab ?? tab;
  React.useEffect(() => {
    if (searchTab) setTab(searchTab);
    if (activeTab === 'knowledge') setKnowledgeVisited(true);
  }, [activeTab, searchTab]);
  const Page = pages[section];
  const selfFetching = section === 'computers' || section === 'bots';
  const showPiSaveStatus = section !== 'index' && !selfFetching && (!combined || activeTab === 'context');
  const content = <>
    {status === 'loading' && !selfFetching ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {error && !selfFetching ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => { void retry(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {section === 'index'
      ? <IndexSettings key={`${targetKey}:${section}`} {...(harness ? { harness, update } : {})} />
      : section === 'computers'
        ? <ComputerSettings />
        : section === 'bots'
          ? <BotSettings />
          : harness ? <Page key={`${targetKey}:${section}`} harness={harness} update={update} /> : null}
  </>;
  return <SettingsPageLayout title={t(`settings.page.harness.page.${section}.title`)}
    description={t(`settings.page.harness.page.${section}.description`)} showSaveStatus={showPiSaveStatus}
    headerEnd={showPiSaveStatus ? <span className="typography-meta text-muted-foreground">{t('settings.harness.userDefaults')}</span> : undefined}
    className="[&>section]:py-5 [&>section]:space-y-4">
    {combined ? <>
      <div role="tablist" aria-label={t('settings.page.harness.page.context.title')} className="mb-5 flex gap-5 border-b border-border/60">
        {(['context', 'knowledge'] as const).map((value) => <button key={value} type="button" role="tab"
          id={`${tabsId}-${value}`} aria-controls={`${tabsId}-${value}-panel`} aria-selected={activeTab === value}
          tabIndex={activeTab === value ? 0 : -1} onClick={() => setTab(value)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'context' : event.key === 'End' ? 'knowledge' : value === 'context' ? 'knowledge' : 'context';
            setTab(next);
            document.getElementById(`${tabsId}-${next}`)?.focus();
          }}
          className={cn('border-b-2 px-0.5 pb-2.5 typography-ui-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeTab === value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {t(value === 'context' ? 'settings.page.harness.context.tab' : 'settings.page.knowledge.title')}
        </button>)}
      </div>
      <div role="tabpanel" id={`${tabsId}-context-panel`} aria-labelledby={`${tabsId}-context`} hidden={activeTab !== 'context'} className="[&>section]:border-t-0 [&>section]:pt-0">
        {content}
      </div>
      <div role="tabpanel" id={`${tabsId}-knowledge-panel`} aria-labelledby={`${tabsId}-knowledge`} hidden={activeTab !== 'knowledge'}>
        {activeTab === 'knowledge' || knowledgeVisited ? <KnowledgeSettings /> : null}
      </div>
    </> : content}
  </SettingsPageLayout>;
}
