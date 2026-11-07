import { createContext } from 'react';

import type { Theme, ThemeMode } from '@/types/theme';
import type { CustomColorField, CustomColorsByTheme } from '@/lib/theme/customColors';

export interface ThemeContextValue {
  currentTheme: Theme;
  availableThemes: Theme[];
  customThemesLoading: boolean;
  customColors: CustomColorsByTheme;
  setCustomColor: (themeId: string, field: CustomColorField, value: string) => void;
  resetCustomColors: (themeId: string) => void;
  importedThemes: Theme[];
  importTheme: (raw: string) => void;
  removeImportedTheme: (themeId: string) => void;
  reloadCustomThemes: () => Promise<void>;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  lightThemeId: string;
  darkThemeId: string;
  setLightThemePreference: (themeId: string) => void;
  setDarkThemePreference: (themeId: string) => void;
}

export const ThemeSystemContext = createContext<ThemeContextValue | undefined>(undefined);
