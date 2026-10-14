import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useHarnessSettings } from './useHarnessSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { ToolsSettings } from './ToolsSettings';
import { PermissionsSettings } from './PermissionsSettings';
import { ContextSettings } from './ContextSettings';
import { RetrievalSettings } from './RetrievalSettings';
import { IndexSettings } from './IndexSettings';
import { WebSettings } from './WebSettings';
import { ComputerSettings } from '../computers/ComputerSettings';
import { BotSettings } from '../bots/BotSettings';
import { ConfigurationRuntime } from './ConfigurationModels';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type HarnessSettingsSection = 'tools' | 'permissions' | 'context' | 'retrieval' | 'index' | 'web' | 'computers' | 'bots';
const pages: Record<HarnessSettingsSection, React.ComponentType<HarnessSettingsPageProps>> = {
  tools: ToolsSettings, permissions: PermissionsSettings,
  context: ContextSettings, retrieval: RetrievalSettings, index: IndexSettings, web: WebSettings,
  // Self-fetching: the computer and bot catalogs come from the Host service,
  // not harness settings — extra props are ignored.
  computers: ComputerSettings, bots: () => <BotSettings /> };

export function HarnessSettingsPage({ section }: { section: HarnessSettingsSection }) {
  const { t } = useI18n();
  const [runtime, setRuntime] = React.useState<'agent' | 'pi'>('agent');
  const { harness, status, error, update, retry, targetKey } = useHarnessSettings(runtime);
  const Page = pages[section];
  const selfFetching = section === 'computers' || section === 'bots';
  const showPiSaveStatus = section !== 'index' && !selfFetching;
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
    headerEnd={showPiSaveStatus ? <Select value={runtime} onValueChange={value => setRuntime(value as 'agent' | 'pi')}><SelectTrigger size="settings" className="w-36" aria-label="Runtime"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="agent">Agent</SelectItem><SelectItem value="pi">Pi</SelectItem></SelectContent></Select> : undefined}
    className="[&>section]:py-5 [&>section]:space-y-4">
    <ConfigurationRuntime.Provider value={runtime}>{content}</ConfigurationRuntime.Provider>
  </SettingsPageLayout>;
}
