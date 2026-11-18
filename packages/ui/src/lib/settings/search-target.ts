import { createContext, useContext } from 'react';

export const SettingsSearchTargetContext = createContext<string | null>(null);
export const useSettingsSearchTarget = () => useContext(SettingsSearchTargetContext);

/** Shell-owned, transient item navigation shared by search results and in-product cross-links. */
export const SettingsItemNavigationContext = createContext<((page: string, item: string) => void) | null>(null);
