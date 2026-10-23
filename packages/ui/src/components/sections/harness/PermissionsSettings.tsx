import React from 'react';
import { resolveHarnessModelSlot, validatePermissionRule, type PermissionMode, type PermissionRule } from '@varin/protocol';
import { SettingsSection, SettingsRadioGroup, SettingsRadioOption } from '../shared/SettingsSection';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { HarnessModelField } from './HarnessModelField';
import type { HarnessSettingsPageProps } from './harness-settings-state';

type RuleRow = { id: string; rule: PermissionRule };
const toRows = (rules: readonly PermissionRule[]): RuleRow[] => rules.map(rule => ({ id: crypto.randomUUID(), rule: structuredClone(rule) }));
export function PermissionsSettings({ harness, update, onSaveRules, saving, error }: HarnessSettingsPageProps & {
  onSaveRules(rules: PermissionRule[]): Promise<boolean>;
  saving: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const rules = React.useMemo(() => harness.permissions?.rules ?? [], [harness.permissions?.rules]);
  const current = JSON.stringify(rules);
  const [baseline, setBaseline] = React.useState(current);
  const [rows, setRows] = React.useState(() => toRows(rules));
  const [editing, setEditing] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dirty = JSON.stringify(rows.map(row => row.rule)) !== baseline;
  React.useEffect(() => {
    if (!dirty && current !== baseline) { setRows(toRows(rules)); setBaseline(current); }
  }, [current, baseline, dirty, rules]);
  const changedElsewhere = dirty && current !== baseline && !submitting;
  let issue: string | null = null, validated: PermissionRule[] = [];
  try {
    validated = rows.map(({ rule }, index) => validatePermissionRule(rule, String(index + 1)));
  } catch (failure) { issue = failure instanceof Error ? failure.message : String(failure); }
  const edit = (id: string, patch: Partial<PermissionRule>) => setRows(previous => previous.map(row => row.id === id ? { ...row, rule: { ...row.rule, ...patch } } : row));
  const move = (index: number, by: number) => setRows(previous => {
    const next = [...previous]; [next[index], next[index + by]] = [next[index + by]!, next[index]!]; return next;
  });
  const save = async () => {
    if (issue || changedElsewhere || submitting) return false;
    setSubmitting(true);
    try {
      const ok = await onSaveRules(validated);
      if (ok && alive.current) { setBaseline(JSON.stringify(validated)); setRows(previous => previous.map((row, i) => ({ ...row, rule: validated[i]! }))); }
      return ok;
    } finally { if (alive.current) setSubmitting(false); }
  };
  const busy = saving || submitting;
  return <>
    <SettingsSection title={t('settings.page.harness.permissions.mode.label')} settingsItem="harness.permissions.mode" divider={false}>
      <SettingsRadioGroup aria-label={t('settings.page.harness.permissions.mode.label')} className="settings-permission-modes">
        {(['normal', 'accept-edits', 'smart', 'bypass'] as const).map((mode: PermissionMode) => <SettingsRadioOption key={mode}
          label={t(`settings.page.harness.permissions.mode.${mode}`)} selected={(harness.permissions?.mode ?? 'normal') === mode}
          disabled={mode === 'smart' && !resolveHarnessModelSlot('permissionJudge', harness.models, null)}
          onSelect={() => update({ permissions: { mode } })} />)}
      </SettingsRadioGroup>
      <div className="mt-4"><HarnessModelField harness={harness} update={update} slot="permissionJudge" />
        {!resolveHarnessModelSlot('permissionJudge', harness.models, null) ? <p className="mt-2 typography-meta text-muted-foreground">{t('settings.page.harness.permissions.smartUnavailable')}</p> : null}
      </div>
    </SettingsSection>
    <SettingsSection title={t('settings.harness.rules.title')} description={t('settings.experience.rulesHint')} settingsItem="harness.permissions.rules"
      headerAction={<Button size="sm" variant="outline" disabled={busy} onClick={() => {
        const id = crypto.randomUUID(); setRows(previous => [...previous, { id, rule: { tool: '', decision: 'ask' } }]); setEditing(id);
      }}><Icon name="add" className="size-4" />{t('settings.harness.rules.add')}</Button>}>
      {!rows.length ? <p className="py-5 typography-meta text-muted-foreground">{t('settings.harness.rules.empty')}</p> : null}
      <div className="divide-y divide-border/60">{rows.map(({ id, rule }, index) => <article key={id} className="py-3">
        <div className="flex items-center gap-2">
          <span className="w-5 shrink-0 typography-micro text-muted-foreground">{index + 1}</span>
          <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={editing === id} onClick={() => setEditing(editing === id ? null : id)}>
            <span className="block break-words font-mono typography-meta">{rule.tool || t('settings.harness.rules.tool')}</span>
            {rule.match ? <span className="block break-words typography-micro text-muted-foreground">{rule.match.param} · {rule.match.pattern}</span> : null}
          </button>
          <span className="shrink-0 typography-meta text-muted-foreground">{t(`settings.harness.rules.${rule.decision}`)}</span>
          <Button variant="ghost" size="icon" disabled={busy || index === 0} aria-label={t('settings.harness.rules.up')} onClick={() => move(index, -1)}><Icon name="arrow-up" className="size-4" /></Button>
          <Button variant="ghost" size="icon" disabled={busy || index === rows.length - 1} aria-label={t('settings.harness.rules.down')} onClick={() => move(index, 1)}><Icon name="arrow-down" className="size-4" /></Button>
          <Button variant="ghost" size="icon" disabled={busy} aria-label={t('settings.harness.rules.remove')} onClick={() => setRows(previous => previous.filter(row => row.id !== id))}><Icon name="delete-bin" className="size-4" /></Button>
        </div>
        <div className="settings-rule-editor" data-open={editing === id} inert={editing !== id}>
          <div><fieldset disabled={busy} className="space-y-3 pt-4 pb-2">
            <div className="flex flex-wrap gap-3"><Input className="min-w-0 flex-1" value={rule.tool} aria-label={t('settings.harness.rules.tool')} placeholder={t('settings.harness.rules.tool')} onChange={event => edit(id, { tool: event.target.value })} />
              <Select value={rule.decision} onValueChange={decision => edit(id, { decision: decision as PermissionRule['decision'] })}><SelectTrigger size="settings" className="w-28" aria-label={t('settings.harness.rules.decision')}><SelectValue /></SelectTrigger><SelectContent>{(['allow','ask','deny'] as const).map(decision => <SelectItem key={decision} value={decision}>{t(`settings.harness.rules.${decision}`)}</SelectItem>)}</SelectContent></Select>
            </div>
            {rule.match ? <><div className="grid gap-3 @xl:grid-cols-2"><Input value={rule.match.param} placeholder={t('settings.harness.rules.param')} aria-label={t('settings.harness.rules.param')} onChange={event => edit(id, { match: { ...rule.match!, param: event.target.value } })} /><Input value={rule.match.pattern} placeholder={t('settings.harness.rules.pattern')} aria-label={t('settings.harness.rules.pattern')} onChange={event => edit(id, { match: { ...rule.match!, pattern: event.target.value } })} /></div>
              <Button variant="ghost" size="sm" onClick={() => { const { match: _match, ...rest } = rule; setRows(previous => previous.map(row => row.id === id ? { ...row, rule: rest } : row)); }}>{t('settings.harness.rules.removeMatch')}</Button></>
              : <Button variant="ghost" size="sm" onClick={() => edit(id, { match: { param: '', pattern: '' } })}>{t('settings.harness.rules.addMatch')}</Button>}
          </fieldset></div>
        </div>
      </article>)}</div>
    </SettingsSection>
    <SettingsActionBar dirty={dirty} saving={busy} onSave={save} saveDisabled={Boolean(issue || changedElsewhere)}
      onCancel={() => { setRows(toRows(rules)); setBaseline(current); setEditing(null); }}
      error={changedElsewhere ? t('settings.experience.ruleChanged') : issue || error} />
  </>;
}
