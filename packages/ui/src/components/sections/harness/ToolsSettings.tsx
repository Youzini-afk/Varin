import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import type { AgentToolPrompt } from '@varin/protocol';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { SettingsPageLink } from '../shared/SettingsPageLink';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import type { HarnessSettingsPageProps } from './harness-settings-state';


const researchTools = ['websearch', 'webfetch', 'document_read', 'research_search', 'materials', 'research_decide'] as const;
const computerTools = ['computer'] as const;
const shells = ['auto', 'git-bash', 'powershell', 'wsl'] as const;

export function ToolsSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = React.useState<AgentToolPrompt[] | null>(null);
  const [query, setQuery] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setError(null);
    void runtimeFetch('/api/agent-personalization/tools', { signal: abort.signal, cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (!abort.signal.aborted) setCatalog(result as AgentToolPrompt[]);
    }).catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => abort.abort();
  }, [attempt]);
  const controlTools = [...researchTools, ...computerTools].filter(name => catalog?.some(tool => tool.name === name));
  const visible = catalog?.filter(tool => (tool.name + ' ' + tool.description).toLowerCase().includes(query.toLowerCase())) ?? [];

  const validNumber = (value: string) => Number.isFinite(Number(value)) && Number(value) > 0
    ? null : t('settings.harness.positiveNumber');
  return <>

    {controlTools.length > 0 && <SettingsSection title={t('settings.page.harness.section.tools')} contentClassName="space-y-1">
      {controlTools.map(tool => <SettingsCheckboxRow key={tool} checked={harness.tools[tool] !== false}
        onChange={checked => update({ tools: { [tool]: checked } })} label={t(`settings.page.harness.tool.${tool}`)}
        description={t(`settings.page.harness.tool.${tool}.description`)} />)}
    </SettingsSection>}
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
    <SettingsSection title={t('settings.experience.toolsDirectory')} description={t('settings.experience.toolsDirectoryHint')} settingsItem="harness.tools">
      <Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('settings.experience.searchTools')} placeholder={t('settings.experience.searchTools')} className="mb-5 max-w-md" />
      {error ? <div role="alert" className="text-destructive typography-meta">{error}<Button variant="ghost" size="sm" onClick={() => setAttempt(value => value + 1)}>{t('settings.harness.retry')}</Button></div> : null}
      {!catalog && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
      <div className="max-h-[28rem] overflow-y-auto">
      {visible.map(tool => <SettingsDisclosure key={tool.name} title={<span className="font-mono">{tool.name}</span>}>
        <p className="mb-3 whitespace-pre-wrap typography-meta text-muted-foreground">{tool.description}</p>
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 typography-micro">{JSON.stringify(tool.schema, null, 2)}</pre>
      </SettingsDisclosure>)}
      </div>
      <div className="mt-5">
        <SettingsPageLink page="agents">{t('settings.experience.agentTools')}</SettingsPageLink>
        <SettingsPageLink page="harness-permissions">{t('settings.experience.managePermissions')}</SettingsPageLink>
      </div>
    </SettingsSection>
  </>;
}
