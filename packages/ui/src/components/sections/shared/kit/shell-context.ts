/* Settings shell context: layout mode, catalog list/detail stage on narrow screens, and navigation between pages. */
import React from 'react';

export type SettingsLayout = 'desktop' | 'narrow' | 'phone';
export type CatalogStage = 'list' | 'detail';

export interface SettingsShellValue {
  layout: SettingsLayout;
  catalogStage: CatalogStage;
  setCatalogStage(stage: CatalogStage): void;
  /** Open another settings page; `item` scrolls to and highlights a [data-settings-item]. `select` is passed to catalog pages. */
  openPage(slug: string, options?: { item?: string; select?: string }): void;
  /** One-shot selection request for a catalog page, consumed by the page on mount. */
  takeSelection(slug: string): string | undefined;
  closeSettings?(): void;
}

const noop = () => {};
const fallback: SettingsShellValue = {
  layout: 'desktop', catalogStage: 'detail', setCatalogStage: noop, openPage: noop, takeSelection: () => undefined,
};
export const SettingsShellContext = React.createContext<SettingsShellValue>(fallback);
export const useSettingsShell = () => React.useContext(SettingsShellContext);

/** Catalog selection that honours a one-shot request from another page (for example "设备详情" buttons). */
export function useCatalogSelection<T extends string>(slug: string, initial: T | (() => T)): [T, (value: T) => void] {
  const shell = useSettingsShell();
  const [value, setValue] = React.useState<T>(() => (shell.takeSelection(slug) as T | undefined) ?? (typeof initial === 'function' ? (initial as () => T)() : initial));
  React.useEffect(() => {
    const requested = shell.takeSelection(slug) as T | undefined;
    if (requested) setValue(requested);
  });
  return [value, setValue];
}

/* Titlebar state published by the settings view and read by the app header. */
export interface SettingsTitlebarState { title: string; stage: 'nav' | 'page'; compact: boolean; back?: () => void; close?: () => void; host?: { name: string; state: 'ok' | 'warn' | 'err'; hint?: string; open(): void } }
let titlebar: SettingsTitlebarState | null = null;
const titlebarListeners = new Set<() => void>();
export function publishSettingsTitlebar(state: SettingsTitlebarState | null) {
  titlebar = state;
  titlebarListeners.forEach(listener => listener());
}
export function useSettingsTitlebar() {
  return React.useSyncExternalStore(
    (listener) => { titlebarListeners.add(listener); return () => { titlebarListeners.delete(listener); }; },
    () => titlebar,
    () => null,
  );
}
