import { createContext } from 'react';

/** Settings navigation owns draft confirmations; embedded editors keep local behavior. */
export const SettingsNavigationContext = createContext(false);
export const SettingsFooterContext = createContext<HTMLElement | null>(null);
