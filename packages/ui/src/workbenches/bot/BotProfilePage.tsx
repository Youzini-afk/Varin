import React from 'react';
import { getRuntimeEndpointGeneration, type BotModelSelection } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { BotModelSelector } from '@/components/sections/bots/BotModelSelector';
import { useHarnessSettings } from '@/components/sections/harness/useHarnessSettings';
import { useI18n } from '@/lib/i18n';
import { updateBot } from '@/lib/bots';
import { useBotPanel } from './botPanelModel';

const sameModel = (a: BotModelSelection | null, b: BotModelSelection | null) => a?.providerId === b?.providerId && a?.modelId === b?.modelId;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Draft state the panel consults before it lets the page close (§5.8). */
export interface BotProfileGuard { dirty: boolean; saving: boolean }

/**
 * The Bot's profile, pushed over the tab content. One draft for name, instructions and model;
 * the sticky bar appears only while there is something to save. Lifecycle and the danger zone
 * act immediately through their own owners.
 */
export function BotProfilePage({ leaving, guard }: { leaving: boolean; guard: React.MutableRefObject<BotProfileGuard> }) {
  const { t } = useI18n();
  const model = useBotPanel();
  const { bot } = model;
  const harness = useHarnessSettings();
  const [name, setName] = React.useState(bot.name);
  const [instructions, setInstructions] = React.useState(bot.instructions ?? '');
  const [selection, setSelection] = React.useState<BotModelSelection | null>(bot.model);
  const [baseline, setBaseline] = React.useState({ id: bot.id, name: bot.name, instructions: bot.instructions ?? '', model: bot.model });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = name !== baseline.name || instructions !== baseline.instructions || !sameModel(selection, baseline.model);
  guard.current = { dirty, saving };
  const locked = Boolean(bot.archived || bot.deletion || saving);
  // A profile change made elsewhere replaces an untouched draft; edits in progress are kept.
  React.useEffect(() => {
    if (dirty && baseline.id === bot.id) return;
    setName(bot.name); setInstructions(bot.instructions ?? ''); setSelection(bot.model);
    setBaseline({ id: bot.id, name: bot.name, instructions: bot.instructions ?? '', model: bot.model });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.name, bot.instructions, bot.model?.providerId, bot.model?.modelId]);
  const discard = () => { setName(baseline.name); setInstructions(baseline.instructions); setSelection(baseline.model); setError(null); };
  const save = async () => {
    if (!name.trim()) return;
    const host = getRuntimeEndpointGeneration();
    setSaving(true); setError(null);
    try {
      const saved = await updateBot(bot.id, { ...(name.trim() !== bot.name ? { name: name.trim() } : {}), instructions: instructions.trim() ? instructions : null, model: selection });
      if (host !== getRuntimeEndpointGeneration()) return;
      setName(saved.name); setInstructions(saved.instructions ?? ''); setSelection(saved.model);
      setBaseline({ id: saved.id, name: saved.name, instructions: saved.instructions ?? '', model: saved.model });
      guard.current = { dirty: false, saving: false };
      model.onBotChanged(saved);
    } catch (cause) {
      if (host === getRuntimeEndpointGeneration()) setError(message(cause));
    } finally {
      if (host === getRuntimeEndpointGeneration()) setSaving(false);
    }
  };
  const state = bot.activity?.state ?? 'awake';
  const transitioning = state === 'sleeping' || state === 'waking';
  const resting = state !== 'awake' && state !== 'sleep-failed';
  const field = 'flex flex-col gap-1.5';
  const label = 'text-[12.5px] text-muted-foreground';

  return <section className="bot-profile-page" data-leaving={leaving || undefined} aria-label={t('bot.profile.title')}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); model.closeProfile(); } }}>
    <header className="sticky top-0 z-[1] flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2.5 text-[13.5px] font-semibold">
      <button type="button" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground" aria-label={t('bot.profile.back')} onClick={model.closeProfile} autoFocus>
        <Icon name="arrow-left-s" className="size-4" />
      </button>
      {t('bot.profile.title')}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-24 pt-4">
      <div className="flex flex-col gap-[18px]">
        <label className={field}><span className={label}>{t('settings.bots.name.label')}</span>
          <Input value={name} disabled={locked} onChange={event => setName(event.target.value)} aria-label={t('settings.bots.name.label')} />
        </label>
        <label className={field}><span className={label}>{t('settings.bots.instructions.label')}</span>
          <Textarea value={instructions} disabled={locked} rows={6} placeholder={t('settings.bots.instructions.placeholder')} onChange={event => setInstructions(event.target.value)} aria-label={t('settings.bots.instructions.label')} />
          <span className="text-[12px] text-muted-foreground">{t('bot.profile.instructionsHint')}</span>
        </label>
        <div className={field}><span className={label}>{t('settings.bots.model.label')}</span>
          <BotModelSelector model={selection} disabled={locked} onChange={(providerId, modelId) => setSelection(providerId && modelId ? { providerId, modelId } : null)} />
          <span className="text-[12px] text-muted-foreground">{t('settings.bots.model.description')}</span>
        </div>
        {harness.harness ? <label className="flex items-center gap-3 text-[13.5px]">
          <span className="min-w-0 flex-1">{t('settings.knowledge.automation.autoOrganize.bot')}</span>
          <Switch checked={harness.harness.knowledge.autoOrganize.bot} onCheckedChange={enabled => harness.update({ knowledge: { autoOrganize: { bot: enabled } } })} />
        </label> : null}
        {harness.error ? <p role="alert" className="typography-meta text-destructive">{harness.error}</p> : null}
        {!bot.archived && !bot.deletion ? <div className="flex items-center gap-3 text-[13.5px]">
          <span className="min-w-0 flex-1">{t('bot.profile.rest')}</span>
          <Button size="sm" variant="outline" disabled={transitioning || model.busy} onClick={() => model.changeState(state === 'sleep-failed' ? 'retry' : resting ? (state === 'wake-failed' ? 'retry' : 'wake') : 'sleep')}>
            <Icon name={resting ? 'play' : 'moon'} className="size-3.5" />
            {t(state === 'sleep-failed' ? 'settings.bots.sleepRetry' : resting ? 'settings.bots.wake' : 'settings.bots.sleep')}
          </Button>
        </div> : null}
        <div className="flex flex-col gap-2 border-t border-border pt-3.5">
          <span className={label}>{t('bot.profile.danger')}</span>
          <div className="flex gap-2">
            {!bot.archived && !bot.deletion ? <Button size="sm" variant="outline" disabled={transitioning || model.busy} onClick={model.archive}><Icon name="archive" className="size-3.5" />{t('settings.bots.archive')}</Button> : null}
            <Button size="sm" variant="outline" className="text-destructive" disabled={transitioning || model.busy || Boolean(bot.deletion && !bot.deletion.error)} onClick={model.requestDelete}><Icon name="delete-bin" className="size-3.5" />{t('settings.bots.delete')}</Button>
          </div>
        </div>
        {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
      </div>
    </div>
    {dirty && !locked ? <div className="bot-savebar" role="region" aria-label={t('bot.profile.unsaved')}>
      <span className="min-w-0 flex-1 truncate">{t('bot.profile.unsaved')}</span>
      <Button size="sm" variant="ghost" disabled={saving} onClick={discard}>{t('bot.profile.discard')}</Button>
      <Button size="sm" disabled={saving || !name.trim()} onClick={() => { void save(); }}>{t(saving ? 'settings.bots.saving' : 'settings.bots.save')}</Button>
    </div> : null}
    {dirty && saving ? <div className="bot-savebar" role="status"><span className="flex-1">{t('settings.bots.saving')}</span></div> : null}
  </section>;
}
