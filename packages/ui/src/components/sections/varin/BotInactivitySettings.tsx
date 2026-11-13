import React from 'react';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { fetchWebSettings, updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsFieldRow } from '../shared/SettingsSection';

export function BotInactivitySettings() {
  const { t } = useI18n();
  const [minutes, setMinutes] = React.useState<number>();
  const [draft, setDraft] = React.useState('20');
  const [error, setError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const context = React.useRef({ generation: 0 });
  React.useEffect(() => {
    const owner = context.current;
    let generation = 0, closed = false;
    const load = async () => {
      const current = ++generation; ++owner.generation; setSaving(false); setMinutes(undefined);
      const settings = await fetchWebSettings();
      if (closed || generation !== current) return;
      if (!settings) { setError(true); return; }
      const value = settings.botTaskInactivityMinutes ?? 20;
      setMinutes(value); setDraft(String(value || 20)); setError(false);
    };
    void load(); const dispose = subscribeRuntimeEndpointChanged(() => void load());
    return () => { closed = true; ++owner.generation; dispose(); };
  }, []);
  const save = async (value: number) => {
    const current = context.current.generation;
    setSaving(true);
    const saved = await updateDesktopSettings({ botTaskInactivityMinutes: value });
    if (current !== context.current.generation) return;
    setSaving(false); setError(!saved);
    if (saved) setMinutes(value);
  };
  return <SettingsFieldRow settingsItem="chat.bot-task-inactivity" label={t('settings.chat.botInactivity')} info={t('settings.chat.botInactivityHint')}>
    <div className="flex flex-wrap items-center gap-3">
      <Switch aria-label={t('settings.chat.botInactivity')} disabled={minutes === undefined || saving} checked={minutes !== undefined && minutes > 0} onCheckedChange={enabled => void save(enabled ? (Number.isSafeInteger(Number(draft)) && Number(draft) > 0 ? Number(draft) : 20) : 0)} />
      {minutes !== undefined && minutes > 0 && <label className="flex items-center gap-2 text-muted-foreground">
        <Input className="w-20" aria-label={t('settings.chat.botInactivityMinutes')} type="number" min={1} step={1} value={draft} disabled={saving}
          onChange={event => setDraft(event.target.value)} onBlur={() => { const value = Number(draft); if (Number.isSafeInteger(value) && value > 0 && value !== minutes) void save(value); else setDraft(String(minutes)); }} />
        {t('settings.chat.botInactivityMinutes')}
      </label>}
      {error && <span role="alert" className="text-destructive typography-meta">{t('settings.chat.botInactivityError')}</span>}
    </div>
  </SettingsFieldRow>;
}
