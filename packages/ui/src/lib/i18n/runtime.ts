import { DEFAULT_LOCALE, normalizeLocale, type Locale } from '@varin/application-client/locale';
export { DEFAULT_LOCALE, LOCALES, normalizeLocale, type Locale } from '@varin/application-client/locale';

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.french' | 'common.language.simplifiedChinese' | 'common.language.traditionalChinese' | 'common.language.ukrainian' | 'common.language.spanish' | 'common.language.brazilianPortuguese' | 'common.language.korean' | 'common.language.polish' | 'common.language.japanese'> = {
  en: 'common.language.english',
  fr: 'common.language.french',
  'zh-CN': 'common.language.simplifiedChinese',
  'zh-TW': 'common.language.traditionalChinese',
  uk: 'common.language.ukrainian',
  es: 'common.language.spanish',
  'pt-BR': 'common.language.brazilianPortuguese',
  ko: 'common.language.korean',
  pl: 'common.language.polish',
  ja: 'common.language.japanese',
};

export const LOCALE_STORAGE_KEY = 'varin.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

export function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredLocale;
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale }));
  } catch {
    return;
  }
}

export function detectInitialLocale(): Locale {
  // A saved desktop preference is shared across local, remote and Mini Chat
  // origins. Without one, preserve the existing browser preference on upgrade.
  if (typeof window !== 'undefined') {
    const desktop = (window as Window & { __VARIN_ELECTRON__?: { locale?: string } }).__VARIN_ELECTRON__;
    if (desktop?.locale) return normalizeLocale(desktop.locale);
  }
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  if (typeof navigator !== 'undefined') {
    const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];

    for (const candidate of candidates) {
      const locale = normalizeLocale(candidate);
      if (locale !== DEFAULT_LOCALE || candidate?.toLowerCase().startsWith('en')) {
        return locale;
      }
    }
  }

  return DEFAULT_LOCALE;
}
