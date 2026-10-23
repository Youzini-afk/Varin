import React from 'react';
import { cn } from '@/lib/utils';

/** The page owns mounted panels and drafts; this only owns tab navigation. */
export function SettingsTabs<T extends string>({ value, onChange, items, label, className }: {
  value: T;
  onChange(value: NoInfer<T>): void;
  items: readonly { value: NoInfer<T>; label: React.ReactNode; controls?: string }[];
  label: string;
  className?: string;
}) {
  return <div role="tablist" aria-label={label} className={cn('settings-tabs', className)}>
    {items.map((item, index) => <button key={item.value} type="button" role="tab" aria-selected={value === item.value}
      aria-controls={item.controls} tabIndex={value === item.value ? 0 : -1} onClick={() => onChange(item.value)}
      onKeyDown={event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : null;
        if (next === null) return;
        event.preventDefault(); onChange(items[next]!.value);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
      }}>{item.label}</button>)}
  </div>;
}
