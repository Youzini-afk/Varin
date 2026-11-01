export type Locale = 'en' | 'fr' | 'zh-CN' | 'zh-TW' | 'uk' | 'es' | 'pt-BR' | 'ko' | 'pl' | 'ja';

export const LOCALES = ['en', 'fr', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export function normalizeLocale(value: string | undefined | null): Locale {
  if (!value) {
    return DEFAULT_LOCALE;
  }

  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-cn' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) {
    return 'zh-CN';
  }
  if (normalized === 'zh-tw' || normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  if (normalized === 'fr' || normalized.startsWith('fr-')) {
    return 'fr';
  }
  if (normalized === 'uk' || normalized.startsWith('uk-') || normalized === 'ua' || normalized.startsWith('ua-')) {
    return 'uk';
  }
  if (normalized === 'es' || normalized.startsWith('es-')) {
    return 'es';
  }
  if (normalized === 'pt' || normalized === 'pt-br' || normalized.startsWith('pt-br-')) {
    return 'pt-BR';
  }
  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return 'ko';
  }
  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return 'ja';
  }
  if (normalized === 'pl' || normalized.startsWith('pl-')) {
    return 'pl';
  }
  return DEFAULT_LOCALE;
}

