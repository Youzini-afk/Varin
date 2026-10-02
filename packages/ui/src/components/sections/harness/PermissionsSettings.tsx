import React from 'react';
import { resolveHarnessModelSlot, validatePermissionRule, type PermissionMode, type PermissionRule } from '@varin/protocol';
import { SettingsSection, SettingsRadioGroup, SettingsRadioOption } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import { HarnessModelField } from './HarnessModelField';
import type { HarnessSettingsPageProps } from './harness-settings-state';

type RuleRow = { id: string; rule: PermissionRule };
export function PermissionsSettings(props: HarnessSettingsPageProps) {
  const { harness, update } = props;
  const { t } = useI18n();
  const rules = harness.permissions?.rules ?? [];
  const [rows, setRows] = React.useState<RuleRow[]>(() => rules.map((rule) => ({ id: crypto.randomUUID(), rule })));
  const rowsRef = React.useRef(rows);
  const [issue, setIssue] = React.useState<string | null>(null);
  const change = (next: RuleRow[]) => {
    rowsRef.current = next;
    setRows(next);
    try {
      if (next.some(({ rule }) => !rule.tool.trim() || (rule.match && (!rule.match.param.trim() || !rule.match.pattern.trim())))) {
        setIssue(t('settings.harness.rules.incomplete'));
        return;
      }
      const valid = next.map(({ rule }, index) => validatePermissionRule(rule, String(index + 1)));
      setIssue(null);
      update({ permissions: { rules: valid } });
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
  };
  const edit = (id: string, patch: Partial<PermissionRule>) => change(rowsRef.current.map((row) => row.id === id ? { ...row, rule: { ...row.rule, ...patch } } : row));
  const editMatch = (id: string, patch: Partial<NonNullable<PermissionRule['match']>>) => {
    const match = rowsRef.current.find((row) => row.id === id)?.rule.match;
    if (match) edit(id, { match: { ...match, ...patch } });
  };
  const move = (index: number, by: number) => {
    const next = [...rowsRef.current];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    change(next);
  };
  return <>
    <SettingsSection title={t('settings.page.harness.permissions.mode.label')} settingsItem="harness.permissions.mode">
      <SettingsRadioGroup aria-label={t('settings.page.harness.permissions.mode.label')} className="space-y-4">
        {(['normal', 'accept-edits', 'bypass', 'smart'] as const).map((mode: PermissionMode) => <SettingsRadioOption key={mode}
          label={t(`settings.page.harness.permissions.mode.${mode}`)} ariaLabel={t(`settings.page.harness.permissions.mode.${mode}`)}
          selected={(harness.permissions?.mode ?? 'normal') === mode}
          disabled={mode === 'smart' && !resolveHarnessModelSlot('permissionJudge', harness.models, null)}
          onSelect={() => update({ permissions: { mode } })} />)}
      </SettingsRadioGroup>
      <div className="mt-5 border-t border-border/50 pt-3"><HarnessModelField {...props} slot="permissionJudge" />
        {!resolveHarnessModelSlot('permissionJudge', harness.models, null) ? <p className="mt-2 typography-meta text-muted-foreground">{t('settings.page.harness.permissions.smartUnavailable')}</p> : null}
      </div>
    </SettingsSection>
    <SettingsSection title={t('settings.harness.rules.title')} description={t('settings.page.harness.permissions.rules.description')}
      settingsItem="harness.permissions.rules" headerAction={<Button size="sm" variant="outline" onClick={() => {
        const next = [...rowsRef.current, { id: crypto.randomUUID(), rule: { tool: '', decision: 'ask' as const } }];
        rowsRef.current = next; setRows(next); setIssue(t('settings.harness.rules.incomplete'));
      }}>{t('settings.harness.rules.add')}</Button>}>
      <div className="space-y-3">
        {rows.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.harness.rules.empty')}</p> : null}
        {rows.map(({ id, rule }, index) => <div key={id} className="rounded-lg border border-border/60 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-5 shrink-0 typography-meta text-muted-foreground">{index + 1}</span>
            <AutoSaveInput value={rule.tool} placeholder={t('settings.harness.rules.tool')} aria-label={t('settings.harness.rules.tool')}
              onCommit={(tool) => edit(id, { tool: tool.trim() })} />
            <Select value={rule.decision} onValueChange={(decision) => edit(id, { decision: decision as PermissionRule['decision'] })}>
              <SelectTrigger size="settings" className="w-28" aria-label={t('settings.harness.rules.decision')}>
                <SelectValue>{t(`settings.harness.rules.${rule.decision}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>{(['allow', 'ask', 'deny'] as const).map((decision) => <SelectItem key={decision} value={decision}>{t(`settings.harness.rules.${decision}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="ghost" size="icon" disabled={index === 0} aria-label={t('settings.harness.rules.up')} onClick={() => move(index, -1)}><Icon name="arrow-up" className="size-4" /></Button>
            <Button variant="ghost" size="icon" disabled={index === rows.length - 1} aria-label={t('settings.harness.rules.down')} onClick={() => move(index, 1)}><Icon name="arrow-down" className="size-4" /></Button>
            <Button variant="ghost" size="icon" aria-label={t('settings.harness.rules.remove')} onClick={() => change(rowsRef.current.filter((row) => row.id !== id))}><Icon name="close" className="size-4" /></Button>
          </div>
          {rule.match ? <div className="flex flex-wrap items-center gap-2 pl-7">
            <AutoSaveInput value={rule.match.param} placeholder={t('settings.harness.rules.param')} aria-label={t('settings.harness.rules.param')}
              onCommit={(param) => editMatch(id, { param: param.trim() })} />
            <AutoSaveInput value={rule.match.pattern} placeholder={t('settings.harness.rules.pattern')} aria-label={t('settings.harness.rules.pattern')}
              onCommit={(pattern) => editMatch(id, { pattern })} />
            <Button variant="ghost" size="sm" onClick={() => {
              const next = rowsRef.current.map((row) => { if (row.id !== id) return row; const { match: _match, ...rest } = row.rule; return { ...row, rule: rest }; });
              change(next);
            }}>{t('settings.harness.rules.removeMatch')}</Button>
          </div> : <Button variant="ghost" size="sm" className="ml-7" onClick={() => edit(id, { match: { param: '', pattern: '' } })}>{t('settings.harness.rules.addMatch')}</Button>}
        </div>)}
        {issue ? <p role="alert" className="typography-meta text-destructive">{issue}</p> : null}
      </div>
    </SettingsSection>
  </>;
}
