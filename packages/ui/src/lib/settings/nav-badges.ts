/* Small status marks next to settings navigation entries (for example a model service that cannot connect).
 * Owners publish facts they already hold; the navigation only renders them. */
import React from 'react';

export interface SettingsNavBadge { hint: string; tone?: 'warn' | 'info' }
let badges: Record<string, SettingsNavBadge> = {};
const listeners = new Set<() => void>();

export function setSettingsNavBadge(slug: string, badge: SettingsNavBadge | null) {
  const current = badges[slug];
  if (!badge && !current) return;
  if (badge && current && current.hint === badge.hint && current.tone === badge.tone) return;
  const next = { ...badges };
  if (badge) next[slug] = badge; else delete next[slug];
  badges = next;
  listeners.forEach(listener => listener());
}

export function useSettingsNavBadges() {
  return React.useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => badges,
    () => badges,
  );
}
