import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { NAME_MARK, splitNamed } from './botPresentation';
import { useSegmentKnob } from './segmentKnob';

/** A translated sentence with the person's name in bold (§5.4). */
export function Named({ id, name, params }: { id: I18nKey; name: string; params?: Record<string, string | number> }) {
  const { t } = useI18n();
  const parts = splitNamed(t(id, { ...params, name: NAME_MARK }));
  if (!parts) return <>{t(id, { ...params, name })}</>;
  return <>{parts.before}<b>{name}</b>{parts.after}</>;
}

/** Two or three choices with one knob that glides to the chosen one. */
export function BotSegment<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
  label: string;
}) {
  const row = React.useRef<HTMLDivElement>(null);
  const knob = React.useRef<HTMLSpanElement>(null);
  useSegmentKnob(row, knob, ':scope > button[aria-pressed="true"]', value);
  return <div ref={row} className="bot-segment" role="group" aria-label={label}>
    <span ref={knob} className="bot-segment-knob" aria-hidden="true" />
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
