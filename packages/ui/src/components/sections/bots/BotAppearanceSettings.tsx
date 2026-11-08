import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, defaultBotAppearance, defaultBotImageCrop, type BotAppearance, type BotAppearanceAsset, type BotAppearanceState, type BotImageCrop, type BotSummary } from '@varin/application-client';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RiUploadLine } from '@remixicon/react';
import { AnimatePresence, motion } from 'motion/react';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { EASE_OUT, springTransition } from '@/lib/motion/tokens';
import { useI18n } from '@/lib/i18n';
import { updateBot } from '@/lib/bots';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { BotImageArtwork } from '@/workbenches/bot/BotImageArtwork';
import { botAppearanceAPI } from '@/workbenches/bot/botAppearanceResources';
import './bot-appearance.css';

const COLORS = ['#8fb0ea', '#ab97cd', '#c68496', '#cf9e66', '#82ac96', '#7baeb8', '#8894a2'];
const PREVIEW_STATES = ['idle', 'thinking', 'working', 'waiting', 'sleeping'] as const;

/** Immediate appearance changes are separate from the surrounding profile's text draft. */
export function BotAppearanceSettings({ bot, disabled, onChanged }: { bot: BotSummary; disabled?: boolean; onChanged?(bot: BotSummary): void }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [saved, setSaved] = React.useState<{ bot: BotSummary; host: number } | null>(null);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const current = saved?.host === host && saved.bot.id === bot.id && saved.bot.revision > bot.revision ? saved.bot : bot;
  return <>
    <div className="bot-appearance-setting">
      <BotFigure bot={current} state="idle" size={64} still />
      <div><span className="typography-settings-field-label">{t('bot.appearance.title')}</span>
        <p className="typography-meta text-muted-foreground">{t(current.appearance?.kind === 'custom' ? 'bot.appearance.custom' : 'bot.appearance.builtin')}</p></div>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>{t('bot.appearance.change')}</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="bot-appearance-dialog max-w-3xl p-0 gap-0 overflow-hidden">
        <AppearanceEditor key={`${host}:${bot.id}`} bot={current} onClose={() => setOpen(false)} onChanged={value => { setSaved({ bot: value, host }); onChanged?.(value); }} />
      </DialogContent>
    </Dialog>
  </>;
}

function AppearanceEditor({ bot, onChanged, onClose }: { bot: BotSummary; onChanged(bot: BotSummary): void; onClose(): void }) {
  const { t } = useI18n();
  const motionLevel = useMotionLevel();
  const [appearance, setAppearance] = React.useState<BotAppearance>(() => bot.appearance ?? defaultBotAppearance());
  const [assets, setAssets] = React.useState<BotAppearanceAsset[]>([]), [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
  const [pose, setPose] = React.useState<BotAppearanceState>('idle');
  const [previewReady, setPreviewReady] = React.useState(false);
  const [cropTarget, setCropTarget] = React.useState<'figure' | 'portrait'>('figure');
  const drag = React.useRef<{ x: number; y: number; crop: BotImageCrop; spanX: number; spanY: number } | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null), alive = React.useRef(true), upload = React.useRef<AbortController | null>(null);
  const host = React.useRef(getRuntimeEndpointGeneration());
  const active = () => alive.current && host.current === getRuntimeEndpointGeneration();
  const refresh = React.useCallback(async () => {
    try { const list = await botAppearanceAPI().list(); if (alive.current && host.current === getRuntimeEndpointGeneration()) { setAssets(list); setLoading(false); } }
    catch (error) { if (alive.current) { setError(String(error)); setLoading(false); } }
  }, []);
  React.useEffect(() => {
    alive.current = true; void refresh();
    const stop = subscribeVarinEvents(event => { if (event.type === 'bot-appearance-library-changed' || event.type === 'stream-ready') void refresh(); });
    return () => { alive.current = false; stop(); upload.current?.abort(); };
  }, [refresh]);
  const selected = appearance.kind === 'custom' ? assets.find(asset => asset.id === appearance.assetId) : undefined;
  const select = (asset?: BotAppearanceAsset) => {
    if (asset ? appearance.kind === 'custom' && appearance.assetId === asset.id : appearance.kind === 'varin') return;
    setError(''); setPose('idle'); setAppearance(asset ? { kind: 'custom', assetId: asset.id, figure: defaultBotImageCrop(), portrait: defaultBotImageCrop() } : defaultBotAppearance());
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(''); const controller = new AbortController(); upload.current = controller;
    try {
      const asset = await botAppearanceAPI().import(file, controller.signal);
      if (!active()) return;
      setAssets(current => [...current.filter(item => item.id !== asset.id), asset]); select(asset);
    } catch (error) { if (active()) setError(String(error)); }
    finally { if (active()) setBusy(false); if (upload.current === controller) upload.current = null; }
  };
  const apply = async () => {
    setBusy(true); setError('');
    try { const saved = await updateBot(bot.id, { appearance }); if (active()) { onChanged(saved); onClose(); } }
    catch (error) { if (active()) setError(String(error)); }
    finally { if (active()) setBusy(false); }
  };
  const remove = async () => {
    if (!selected || !window.confirm(t('bot.appearance.removeConfirm', { name: selected.name }))) return;
    setBusy(true); setError('');
    try { await botAppearanceAPI().remove(selected.id); if (active()) { select(); await refresh(); } }
    catch (error) { if (active()) setError(String(error)); }
    finally { if (active()) setBusy(false); }
  };
  const crop = appearance.kind === 'custom' ? appearance[cropTarget] : defaultBotImageCrop();
  const changeCrop = (value: Partial<BotImageCrop>) => setAppearance(current => current.kind === 'custom' ? { ...current, [cropTarget]: { ...current[cropTarget], ...value } } : current);
  const startCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (appearance.kind !== 'custom' || event.button !== 0) return;
    const image = event.currentTarget.querySelector('img'), frame = event.currentTarget.querySelector('.bot-image-artwork');
    if (!image?.naturalWidth || !frame) return;
    const { width, height } = frame.getBoundingClientRect();
    const fit = cropTarget === 'portrait' ? Math.max(width / image.naturalWidth, height / image.naturalHeight) : Math.min(width / image.naturalWidth, height / image.naturalHeight);
    drag.current = { x: event.clientX, y: event.clientY, crop, spanX: width - image.naturalWidth * fit * crop.scale, spanY: height - image.naturalHeight * fit * crop.scale };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  };
  const moveCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const moving = drag.current; if (!moving) return;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    changeCrop({ x: Math.abs(moving.spanX) < 1 ? moving.crop.x : clamp(moving.crop.x + (event.clientX - moving.x) / moving.spanX),
      y: Math.abs(moving.spanY) < 1 ? moving.crop.y : clamp(moving.crop.y + (event.clientY - moving.y) / moving.spanY) });
  };
  return <>
    <DialogHeader className="px-6 pt-6 pb-4 pr-10"><DialogTitle>{t('bot.appearance.change')}</DialogTitle><DialogDescription>{t('bot.appearance.description', { name: bot.name })}</DialogDescription></DialogHeader>
    <div className="bot-appearance-editor">
      <div className="bot-appearance-preview">
        <div className="bot-appearance-preview-stage" data-cropping={appearance.kind === 'custom' || undefined} onPointerDown={startCrop} onPointerMove={moveCrop} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
          <BotFigure appearance={appearance} {...(selected ? { asset: selected } : {})} portrait={appearance.kind === 'custom' && cropTarget === 'portrait'} state={pose} size={216} onReady={setPreviewReady} onError={setError} />
        </div>
        <div className="bot-appearance-mini"><BotFigure appearance={appearance} {...(selected ? { asset: selected } : {})} state={pose} size={26} still /><span>{bot.name}</span></div>
        <div className="bot-appearance-poses" aria-label={t('bot.appearance.preview')}>
          {PREVIEW_STATES.map(state => <button key={state} type="button" aria-pressed={pose === state} onClick={() => setPose(state)}>{t(`bot.appearance.state.${state}`)}</button>)}
        </div>
      </div>
      <div className="bot-appearance-options">
        <div className="bot-appearance-library-heading"><span>{t('bot.appearance.library')}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><RiUploadLine className="size-4" />{t('bot.appearance.import')}</Button></div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,.zip" hidden onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
        <div className="bot-appearance-library" role="group" aria-label={t('bot.appearance.library')}>
          <button type="button" aria-pressed={appearance.kind === 'varin'} disabled={busy} onClick={() => select()}><BotFigure appearance={{ kind: 'varin', color: 'theme' }} state="idle" size={56} still /><span>Varin</span></button>
          {assets.map(asset => <button key={asset.id} type="button" disabled={busy} aria-pressed={appearance.kind === 'custom' && appearance.assetId === asset.id} title={asset.name} onClick={() => select(asset)}><span className="bot-appearance-library-image"><BotImageArtwork asset={asset} compact still /></span><span>{asset.name}</span></button>)}
        </div>
        {loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
        <p className="typography-meta text-muted-foreground">{t('bot.appearance.importHint')}</p>
        <motion.div layout={motionLevel === 'full'} transition={springTransition('glide')}>
        <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={appearance.kind} initial={{ opacity: 0, y: motionLevel === 'full' ? 5 : 0 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: motionLevel === 'off' ? 0 : .16, ease: EASE_OUT }}>
        {appearance.kind === 'varin' ? <div className="bot-appearance-controls">
          <label>{t('bot.appearance.color')}<select value={['theme', 'original'].includes(appearance.color) ? appearance.color : 'custom'} onChange={event => setAppearance({ kind: 'varin', color: event.target.value === 'custom' ? COLORS[0]! : event.target.value })}>
            <option value="theme">{t('bot.appearance.followTheme')}</option><option value="original">{t('bot.appearance.original')}</option><option value="custom">{t('bot.appearance.customColor')}</option>
          </select></label>
          {!['theme', 'original'].includes(appearance.color) && <div className="bot-appearance-colors">
            {COLORS.map(color => <button type="button" key={color} aria-label={color} aria-pressed={appearance.color === color} style={{ '--swatch': color } as React.CSSProperties} onClick={() => setAppearance({ kind: 'varin', color })} />)}
            <input type="color" aria-label={t('bot.appearance.customColor')} value={appearance.color} onChange={event => setAppearance({ kind: 'varin', color: event.target.value })} />
          </div>}
        </div> : <div className="bot-appearance-controls">
          <label>{t('bot.appearance.crop')}<select value={cropTarget} onChange={event => setCropTarget(event.target.value as 'figure' | 'portrait')}><option value="figure">{t('bot.appearance.figure')}</option><option value="portrait">{t('bot.appearance.portrait')}</option></select></label>
          <p className="typography-meta text-muted-foreground">{t('bot.appearance.dragHint')}</p>
          {(['x', 'y', 'scale'] as const).map(key => <label key={key}>{t(`bot.appearance.crop.${key}`)}<input type="range" min={key === 'scale' ? .5 : 0} max={key === 'scale' ? Math.max(3, crop.scale) : 1} step={.01} value={crop[key]} onChange={event => changeCrop({ [key]: Number(event.target.value) })} /></label>)}
          <div className="flex justify-between"><Button variant="ghost" size="sm" onClick={() => changeCrop(defaultBotImageCrop())}>{t('bot.appearance.resetCrop')}</Button><Button variant="ghost" size="sm" className="text-destructive" disabled={busy || !selected} onClick={() => { void remove(); }}>{t('bot.appearance.remove')}</Button></div>
          {selected && Object.keys(selected.states).length === 0 && <p className="typography-meta text-muted-foreground">{t('bot.appearance.staticHint')}</p>}
        </div>}
        </motion.div></AnimatePresence></motion.div>
      </div>
    </div>
    <DialogFooter className="border-t border-border px-6 py-4 items-center">
      <span className="flex-1 typography-meta text-destructive" role={error ? 'alert' : undefined}>{error}{error && <button type="button" className="ml-2 underline" onClick={() => { setError(''); void refresh(); }}>{t('common.retry')}</button>}</span>
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
      <Button disabled={busy || !previewReady || appearance.kind === 'custom' && !selected} onClick={() => { void apply(); }}>{t(busy ? 'settings.bots.saving' : 'bot.appearance.apply')}</Button>
    </DialogFooter>
  </>;
}
