import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useHarnessSettings } from './useHarnessSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { ImageToolsSettings } from './ImageToolsSettings';
import { ToolsSettings } from './ToolsSettings';
import { PermissionsSettings } from './PermissionsSettings';
import { ContextSettings } from './ContextSettings';
import { RetrievalSettings } from './RetrievalSettings';
import { EmbeddingSettings } from './EmbeddingSettings';
import { WebSettings } from './WebSettings';
import { ComputerSettings } from '../computers/ComputerSettings';
import { BotSettings } from '../bots/BotSettings';

export type HarnessSettingsSection = 'images' | 'tools' | 'permissions' | 'context' | 'retrieval' | 'embeddings' | 'web' | 'computers' | 'bots';
const pages: Record<Exclude<HarnessSettingsSection, 'context' | 'permissions'>, React.ComponentType<HarnessSettingsPageProps>> = {
  images: ImageToolsSettings, tools: ToolsSettings,
  retrieval: RetrievalSettings, embeddings: EmbeddingSettings, web: WebSettings,
  // Self-fetching: the computer and bot catalogs come from the Host service,
  // not harness settings — extra props are ignored.
  computers: ComputerSettings, bots: () => <BotSettings /> };

export function HarnessSettingsPage({ section }: { section: HarnessSettingsSection }) {
  const { t } = useI18n();
  const { harness, reserveRatio, status, error, update, commit, updateReserveRatio, retry, targetKey } = useHarnessSettings();
  const Page = section === 'context' || section === 'permissions' ? null : pages[section];
  const selfFetching = section === 'computers' || section === 'bots';
  const showSaveStatus = !selfFetching;
  const content = <>
    {status === 'loading' && !selfFetching ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {error && !selfFetching ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => { void retry(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {section === 'computers'
        ? <ComputerSettings />
        : section === 'bots'
          ? <BotSettings />
          : section === 'context' && harness
            ? <ContextSettings key={`${targetKey}:${section}`} harness={harness} update={update} reserveRatio={reserveRatio} onReserveRatioChange={updateReserveRatio} />
          : section === 'permissions' && harness
            ? <PermissionsSettings key={`${targetKey}:${section}`} harness={harness} update={update} onSaveRules={rules => commit({ permissions: { rules } })} saving={status === 'saving'} error={error} />
            : harness && Page ? <Page key={`${targetKey}:${section}`} harness={harness} update={update} /> : null}
  </>;
  return <SettingsPageLayout title={t(section === 'images' ? 'settings.page.images.title' : `settings.page.harness.page.${section}.title`)}
    description={t(section === 'images' ? 'settings.harness.images.description' : `settings.page.harness.page.${section}.description`)} showSaveStatus={showSaveStatus}
    scope={!selfFetching ? t('settings.scope.hostGlobalHint') : undefined}
    className="[&>section]:py-5 [&>section]:space-y-4">
    {content}
  </SettingsPageLayout>;
}
