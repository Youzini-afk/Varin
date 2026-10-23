import React from 'react';

/** Page-local navigation scrolls within the existing settings scroller. */
export function SettingsPageNav({ items, label }: { items: readonly { id: string; label: string }[]; label: string }) {
  return <nav aria-label={label} className="settings-page-nav">{items.map(item => <button key={item.id} type="button" onClick={event => {
    const page = event.currentTarget.closest('[data-settings-page]');
    const target = [...(page?.querySelectorAll<HTMLElement>('[data-settings-item], [id]') ?? [])].find(node => node.dataset.settingsItem === item.id || node.id === item.id);
    for (let node = target?.parentElement; node && node !== page; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
    target?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }}>{item.label}</button>)}</nav>;
}
