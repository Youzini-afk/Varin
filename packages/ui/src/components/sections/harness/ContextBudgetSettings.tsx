import React from 'react';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import './context-budget.css';

type Boundary = 'prepare' | 'replace';
type Values = { reserve: number; waterline: number };
interface Props {
  reserveRatio: number;
  preparationWaterline: number;
  backgroundPreparation: boolean;
  onReserveRatioChange(value: number): void;
  onPreparationWaterlineChange(value: number): void;
}
const percent = (value: number) => Number((value * 100).toFixed(2));
const inputPercent = (value: number) => String(Number((value * 100).toPrecision(12)));

/** The scale uses the full window; preparation remains a fraction of usable input. */
export function ContextBudgetSettings(props: Props) {
  const { t } = useI18n();
  const { onReserveRatioChange, onPreparationWaterlineChange } = props;
  const [preview, setPreview] = React.useState<Values | null>(null);
  const previewRef = React.useRef<Values | null>(null);
  const track = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ kind: Boundary; pointer: number; x: number; width: number; original: Values; element: HTMLButtonElement } | null>(null);
  const values = preview ?? { reserve: props.reserveRatio, waterline: props.preparationWaterline };
  const replace = 1 - values.reserve, prepare = replace * values.waterline;
  const finish = React.useCallback((commit: boolean) => {
    const gesture = drag.current, next = previewRef.current;
    drag.current = null; previewRef.current = null; setPreview(null);
    if (!gesture) return;
    if (gesture.element.hasPointerCapture?.(gesture.pointer)) gesture.element.releasePointerCapture(gesture.pointer);
    if (!commit || !next) return;
    if (gesture.kind === 'prepare' && next.waterline !== gesture.original.waterline) onPreparationWaterlineChange(next.waterline);
    if (gesture.kind === 'replace' && next.reserve !== gesture.original.reserve) onReserveRatioChange(next.reserve);
  }, [onPreparationWaterlineChange, onReserveRatioChange]);
  React.useEffect(() => {
    if (drag.current && (drag.current.original.reserve !== props.reserveRatio || drag.current.original.waterline !== props.preparationWaterline || !props.backgroundPreparation && drag.current.kind === 'prepare')) finish(false);
  }, [props.reserveRatio, props.preparationWaterline, props.backgroundPreparation, finish]);
  React.useEffect(() => {
    const cancel = () => finish(false);
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [finish]);
  React.useEffect(() => () => { drag.current = null; previewRef.current = null; }, []);
  const start = (kind: Boundary, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.isPrimary === false || drag.current) return;
    const width = track.current?.getBoundingClientRect().width;
    if (!width) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
    drag.current = { kind, pointer: event.pointerId, x: event.clientX, width, original: { reserve: props.reserveRatio, waterline: props.preparationWaterline }, element: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const delta = (event.clientX - gesture.x) / gesture.width;
    if (!delta && !previewRef.current) return;
    const originalReplace = 1 - gesture.original.reserve;
    // Dragging snaps to 0.1 percentage points; typed values retain protocol precision.
    const snapped = (n: number) => Math.round(n * 1000) / 1000;
    const next = gesture.kind === 'prepare'
      ? { ...gesture.original, waterline: Math.max(0.001, Math.min(0.999, snapped(gesture.original.waterline + delta / originalReplace))) }
      : { ...gesture.original, reserve: 1 - Math.max(0.001, Math.min(1, snapped(originalReplace + delta))) };
    previewRef.current = next; setPreview(next);
  };
  const keyboard = (kind: Boundary, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(false); return; }
    const direction = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[event.key];
    if (!direction || drag.current) return;
    event.preventDefault();
    const value = Number(((kind === 'prepare' ? values.waterline : replace) + direction * (event.shiftKey ? 0.001 : 0.01)).toFixed(12));
    if (value <= 0 || (kind === 'prepare' ? value >= 1 : value > 1)) return;
    if (kind === 'prepare') onPreparationWaterlineChange(value); else onReserveRatioChange(1 - value);
  };
  const marker = (kind: Boundary) => <button type="button" role="slider" className={`context-budget-marker context-budget-marker-${kind}`}
    disabled={kind === 'prepare' && !props.backgroundPreparation} aria-label={t(kind === 'prepare' ? 'settings.contextScale.prepare' : 'settings.contextScale.replace')}
    aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(kind === 'prepare' ? values.waterline : replace)}
    aria-valuetext={kind === 'prepare' ? t('settings.contextScale.prepareValue', { value: percent(values.waterline), position: percent(prepare) }) : t('settings.contextScale.replaceValue', { value: percent(replace), reserve: percent(values.reserve) })}
    onPointerDown={event => start(kind, event)} onPointerMove={move}
    onPointerUp={event => { if (event.pointerId === drag.current?.pointer) finish(true); }}
    onPointerCancel={event => { if (event.pointerId === drag.current?.pointer) finish(false); }}
    onLostPointerCapture={event => { if (event.pointerId === drag.current?.pointer) finish(false); }} onKeyDown={event => keyboard(kind, event)} />;
  const validate = (kind: Boundary, text: string) => {
    const value = Number(text);
    return text.trim() && Number.isFinite(value) && value > 0 && (kind === 'prepare' ? value < 100 : value <= 100)
      ? null : t(kind === 'prepare' ? 'settings.contextScale.prepareInvalid' : 'settings.contextScale.replaceInvalid');
  };
  return <div className="context-budget" data-preparation={props.backgroundPreparation} data-dragging={Boolean(preview)} style={{ '--context-prepare': `${prepare * 100}%`, '--context-replace': `${replace * 100}%` } as React.CSSProperties}>
    <div className="context-budget-axis"><span>0%</span><span>{t('settings.contextScale.window')}</span></div>
    <div className="context-budget-track" ref={track}><div className="context-budget-ordinary" /><div className="context-budget-preparing" /><div className="context-budget-reserve" />
      {marker('prepare')}<span className="context-budget-position context-budget-position-prepare">{t('settings.contextScale.preparePosition', { value: percent(prepare) })}</span>
      {marker('replace')}<span className="context-budget-position context-budget-position-replace">{t('settings.contextScale.replacePosition', { value: percent(replace) })}</span>
    </div>
    <div className="context-budget-legend"><span>{t('settings.contextScale.continue')}</span>{props.backgroundPreparation && <span>{t('settings.contextScale.preparing')}</span>}<span>{t('settings.contextScale.reserve', { value: percent(values.reserve) })}</span></div>
    <div className="context-budget-fields">
      <div data-settings-item="harness.context.preparationWaterline"><label className="typography-settings-field-label" htmlFor="context-budget-prepare">{t('settings.contextScale.prepare')}</label>
        <div className="mt-3 flex items-center gap-2"><div className="w-24"><AutoSaveInput id="context-budget-prepare" type="number" step="any" value={inputPercent(values.waterline)} disabled={!props.backgroundPreparation || Boolean(preview)} validate={value => validate('prepare', value)} onCommit={value => onPreparationWaterlineChange(Number(value) / 100)} /></div><span className="typography-meta text-muted-foreground">{t('settings.contextScale.inputBudget')}</span></div>
        <p className="mt-2 typography-meta text-muted-foreground">{t('settings.contextScale.prepareHint', { value: percent(prepare) })}</p>
      </div>
      <div><label className="typography-settings-field-label" htmlFor="context-budget-replace">{t('settings.contextScale.replace')}</label>
        <div className="mt-3 flex items-center gap-2"><div className="w-24"><AutoSaveInput id="context-budget-replace" type="number" step="any" value={inputPercent(replace)} disabled={Boolean(preview)} validate={value => validate('replace', value)} onCommit={value => onReserveRatioChange(1 - Number(value) / 100)} /></div><span className="typography-meta text-muted-foreground">{t('settings.contextScale.fullWindow')}</span></div>
        <p className="mt-2 typography-meta text-muted-foreground">{t('settings.contextScale.replaceHint', { value: percent(values.reserve) })}</p>
      </div>
    </div>
    <p className="my-5 typography-micro text-muted-foreground">{t('settings.contextScale.dragHint')}</p>
    <SettingsDisclosure title={t('settings.contextScale.calculation')}><p className="typography-meta leading-relaxed text-muted-foreground">{t('settings.contextScale.formula')}</p></SettingsDisclosure>
  </div>;
}
