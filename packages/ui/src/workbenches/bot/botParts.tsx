import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { placeInstantly } from '@/lib/motion/slidingPill';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { NAME_MARK, splitNamed } from './botPresentation';

/** A translated sentence with the person's name in bold (§5.4). */
export function Named({ id, name, params }: { id: I18nKey; name: string; params?: Record<string, string | number> }) {
  const { t } = useI18n();
  const parts = splitNamed(t(id, { ...params, name: NAME_MARK }));
  if (!parts) return <>{t(id, { ...params, name })}</>;
  return <>{parts.before}<b>{name}</b>{parts.after}</>;
}

/**
 * Two or three choices with one knob that glides to the chosen one. It is placed without motion
 * the first time and when the row resizes, so only a change of choice moves it.
 */
export function BotSegment<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
  label: string;
}) {
  const row = React.useRef<HTMLDivElement>(null);
  const knob = React.useRef<HTMLSpanElement>(null);
  const placed = React.useRef(false);
  React.useLayoutEffect(() => {
    const root = row.current, pill = knob.current;
    if (!root || !pill) return undefined;
    const place = (animate: boolean) => {
      const active = root.querySelector<HTMLElement>(':scope > button[aria-pressed="true"]');
      if (!active) return;
      const apply = () => { pill.style.translate = `${active.offsetLeft}px 0`; pill.style.width = `${active.offsetWidth}px`; };
      if (animate && placed.current && documentMotionLevel() === 'full') apply();
      else placeInstantly(pill, apply);
      placed.current = true;
    };
    place(true);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(root);
    return () => observer.disconnect();
  }, [value]);
  return <div ref={row} className="bot-segment" role="group" aria-label={label}>
    <span ref={knob} className="bot-segment-knob" aria-hidden="true" />
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
