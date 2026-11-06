import React from 'react';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTION_MAP } from '@/lib/fontOptions';
import { loadMonoFont, loadUiFont } from '@/lib/fontLoader';
import { useThemeSystem } from '@/contexts/useThemeSystem';

export function useAppFontEffects() {
  const { uiFont, monoFont } = useFontPreferences();
  const { currentTheme } = useThemeSystem();
  const themeFonts = currentTheme.metadata.tags?.includes('codex-import') ? currentTheme.config?.fonts : undefined;

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const uiStack = (uiFont === DEFAULT_UI_FONT && themeFonts?.sans) || UI_FONT_OPTION_MAP[uiFont]?.stack || UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack;
    const monoStack = (monoFont === DEFAULT_MONO_FONT && themeFonts?.mono) || CODE_FONT_OPTION_MAP[monoFont]?.stack || CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack;
    void loadUiFont(uiFont);
    void loadMonoFont(monoFont);

    root.style.setProperty('--font-sans', uiStack);
    root.style.setProperty('--font-heading', uiStack);
    root.style.setProperty('--font-family-sans', uiStack);
    root.style.setProperty('--font-mono', monoStack);
    root.style.setProperty('--font-family-mono', monoStack);
    root.style.setProperty('--ui-regular-font-weight', '400');

    if (document.body) {
      document.body.style.fontFamily = uiStack;
    }
  }, [uiFont, monoFont, themeFonts?.sans, themeFonts?.mono]);
}
