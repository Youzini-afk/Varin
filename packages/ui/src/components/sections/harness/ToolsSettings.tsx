import React from 'react';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import type { HarnessSettingsPageProps } from './harness-settings-state';

const tools = ['bash', 'grep', 'get_output', 'write_to_process', 'kill_shell', 'diagnostics', 'apply_patch'] as const;
const researchTools = ['websearch', 'webfetch', 'document_read', 'research_search', 'materials', 'research_decide'] as const;
const computerTools = ['computer'] as const;
const shells = ['auto', 'git-bash', 'powershell', 'wsl'] as const;

export function ToolsSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const validNumber = (value: string) => Number.isFinite(Number(value)) && Number(value) > 0
    ? null : t('settings.harness.positiveNumber');
  return <>
    <SettingsSection title={t('settings.page.harness.section.tools')} settingsItem="harness.tools" contentClassName="space-y-3">
      {tools.map((tool) => <SettingsCheckboxRow key={tool} checked={harness.tools[tool] !== false}
        onChange={(checked) => update({ tools: { [tool]: checked } })}
        ariaLabel={t(`settings.page.harness.tool.${tool}`)} label={t(`settings.page.harness.tool.${tool}`)}
        description={t(`settings.page.harness.tool.${tool}.description`)} />)}
      {researchTools.map((tool) => <SettingsCheckboxRow key={tool} checked={harness.tools[tool] !== false}
        onChange={(checked) => update({ tools: { [tool]: checked } })}
        ariaLabel={t(`settings.page.harness.tool.${tool}`)} label={t(`settings.page.harness.tool.${tool}`)}
        description={t(`settings.page.harness.tool.${tool}.description`)} />)}
      {computerTools.map((tool) => <SettingsCheckboxRow key={tool} checked={harness.tools[tool] !== false}
        onChange={(checked) => update({ tools: { [tool]: checked } })}
        ariaLabel={t(`settings.page.harness.tool.${tool}`)} label={t(`settings.page.harness.tool.${tool}`)}
        description={t(`settings.page.harness.tool.${tool}.description`)} />)}
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.section.shell')} settingsItem="harness.shell" contentClassName="space-y-5">
      <SettingsFieldRow label={t('settings.page.harness.shell.label')} description={t('settings.page.harness.shell.description')}>
        <Select value={harness.shell} onValueChange={(shell) => update({ shell })}>
          <SelectTrigger size="settings" className="w-56" aria-label={t('settings.page.harness.shell.label')}>
            <SelectValue>{t(`settings.page.harness.shell.option.${harness.shell}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>{shells.map((shell) => <SelectItem key={shell} value={shell}>{t(`settings.page.harness.shell.option.${shell}`)}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.bash.waitMs.label')} description={t('settings.page.harness.bash.waitMs.description')}>
        <AutoSaveInput className="w-24" type="number" aria-label={t('settings.page.harness.bash.waitMs.label')}
          value={String(harness.bash.waitMs / 1000)} validate={validNumber}
          onCommit={(value) => update({ bash: { waitMs: Math.round(Number(value) * 1000) } })} />
        <span className="typography-meta text-muted-foreground">s</span>
      </SettingsFieldRow>
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.section.output')} settingsItem="harness.output">
      <SettingsFieldRow label={t('settings.page.harness.output.visibleBytes.label')} description={t('settings.page.harness.output.visibleBytes.description')}>
        <AutoSaveInput className="w-24" type="number" aria-label={t('settings.page.harness.output.visibleBytes.label')}
          value={String(harness.output.visibleBytes / 1024)} validate={validNumber}
          onCommit={(value) => update({ output: { visibleBytes: Math.round(Number(value) * 1024) } })} />
        <span className="typography-meta text-muted-foreground">KiB</span>
      </SettingsFieldRow>
    </SettingsSection>
  </>;
}
