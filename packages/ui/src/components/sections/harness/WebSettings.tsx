import React from 'react';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { SettingsPageNav } from '../shared/SettingsPageNav';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { SearchConnectionsSettings } from './SearchConnectionsSettings';
import { AutoSaveInput } from './AutoSaveInput';
import { WebAssistanceSettings } from './WebAssistanceSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';


const domainList = (value: string) => [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];


export function WebSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const allow = harness.web?.domains?.allow;
  const allowEnabled = React.useRef(allow !== undefined);
  allowEnabled.current = allow !== undefined;
  return <>
    <SettingsPageNav label={t('settings.page.harness.page.web.title')} items={[
      { id: 'harness.web.search', label: t('settings.page.harness.section.web') },
      { id: 'harness.web.assistance', label: t('settings.page.harness.web.assistance.title') },
      { id: 'harness.document-reading', label: t('settings.page.harness.web.documentReading.title') },
      { id: 'harness.web.domains', label: t('settings.page.harness.web.domains.title') },
    ]} />
    <SearchConnectionsSettings harness={harness} update={update} />
    <WebAssistanceSettings harness={harness} update={update} />
    <SettingsSection title={t('settings.page.harness.web.render')} settingsItem="harness.web.render">
      <SettingsCheckboxRow checked={harness.web?.render === true} onChange={(render) => update({ web: { render } })}
        disabled={!isDesktopLocalOriginActive()} ariaLabel={t('settings.page.harness.web.render')}
        label={t('settings.page.harness.web.render')} description={t('settings.page.harness.web.render.description')} />
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.web.documentReading.title')}
      description={t('settings.page.harness.web.documentReading.description')}
      settingsItem="harness.document-reading" contentClassName="space-y-4">
      <SettingsDisclosure title={t('settings.experience.documentComponents')}>
      <SettingsFieldRow label={t('settings.page.harness.web.documentReading.doclingCommand')}
        description={t('settings.page.harness.web.documentReading.executableHint')}
        controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={harness.documentReading.doclingCommand}
          placeholder="docling" aria-label={t('settings.page.harness.web.documentReading.doclingCommand')}
          onCommit={(value) => update({ documentReading: { doclingCommand: value.trim() || undefined } })} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.web.documentReading.tesseractCommand')}
        description={t('settings.page.harness.web.documentReading.executableHint')}
        controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={harness.documentReading.tesseractCommand}
          placeholder="tesseract" aria-label={t('settings.page.harness.web.documentReading.tesseractCommand')}
          onCommit={(value) => update({ documentReading: { tesseractCommand: value.trim() || undefined } })} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.web.documentReading.ocrLanguage')}
        controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={harness.documentReading.ocrLanguage}
          placeholder="eng" aria-label={t('settings.page.harness.web.documentReading.ocrLanguage')}
          onCommit={(value) => update({ documentReading: { ocrLanguage: value.trim() || undefined } })} />
      </SettingsFieldRow>
      <p className="typography-meta text-muted-foreground">
        {t('settings.page.harness.web.documentReading.defaultsRestored')}
      </p>
      </SettingsDisclosure>
    </SettingsSection>
    <SettingsSection title={t('settings.webConnections.preferences')} settingsItem="harness.web.sourcePreferences" contentClassName="space-y-4">
      <p className="typography-meta text-muted-foreground">{t('settings.webConnections.preferencesDescription')}</p>
      <SettingsFieldRow label={t('settings.webConnections.preferred')}>
        <AutoSaveInput value={(harness.web?.sourcePreferences?.preferredDomains ?? []).join(', ')}
          onCommit={value => update({ web: { sourcePreferences: { preferredDomains: domainList(value) } } })} placeholder="docs.example.com" />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.webConnections.excluded')}>
        <AutoSaveInput value={(harness.web?.sourcePreferences?.excludedDomains ?? []).join(', ')}
          onCommit={value => update({ web: { sourcePreferences: { excludedDomains: domainList(value) } } })} placeholder="ads.example.com" />
      </SettingsFieldRow>
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.web.domains.title')} description={t('settings.page.harness.web.domains.description')}
      settingsItem="harness.web.domains" contentClassName="space-y-5">
      <SettingsCheckboxRow checked={allow !== undefined} onChange={(enabled) => { allowEnabled.current = enabled; update({ web: { domains: { allow: enabled ? [] : undefined } } }); }}
        ariaLabel={t('settings.page.harness.web.domains.allowEnabled')} label={t('settings.page.harness.web.domains.allowEnabled')}
        description={t('settings.page.harness.web.domains.allowEnabled.description')} />
      {allow !== undefined ? <SettingsFieldRow label={t('settings.page.harness.web.domains.allow')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={allow.join(', ')} onCommit={(value) => { if (allowEnabled.current) update({ web: { domains: { allow: domainList(value) } } }); }}
          aria-label={t('settings.page.harness.web.domains.allow')} placeholder="example.com, docs.example.com" />
      </SettingsFieldRow> : null}
      <SettingsFieldRow label={t('settings.page.harness.web.domains.block')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={(harness.web?.domains?.block ?? []).join(', ')} onCommit={(value) => update({ web: { domains: { block: domainList(value) } } })}
          aria-label={t('settings.page.harness.web.domains.block')} placeholder="ads.example.com" />
      </SettingsFieldRow>
    </SettingsSection>
  </>;
}
