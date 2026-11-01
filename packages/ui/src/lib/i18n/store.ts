import { create } from 'zustand';
import type { VarinDesktopBridge, VarinDesktopEventMap } from '@varin/application-client/desktop';

import { dict as enDict, type I18nKey } from './messages/en';
import { DEFAULT_LOCALE, detectInitialLocale, LOCALE_STORAGE_KEY, normalizeLocale, readStoredLocale, type Locale, writeStoredLocale } from './runtime';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
export type I18nDictionary = Record<I18nKey, string>;

type I18nState = {
  locale: Locale;
  dictionary: I18nDictionary;
  loadingLocale: Locale | null;
  setLocale: (locale: Locale) => Promise<void>;
};

const dictionaries = new Map<Locale, I18nDictionary>([[DEFAULT_LOCALE, enDict]]);
const dictionaryLoads = new Map<Locale, Promise<I18nDictionary>>();

export function resetI18nDictionaryCacheForTests(): void {
  dictionaries.clear();
  dictionaries.set(DEFAULT_LOCALE, enDict);
  dictionaryLoads.clear();
}

async function loadDictionary(locale: Locale): Promise<I18nDictionary> {
  const cached = dictionaries.get(locale);
  if (cached) {
    return cached;
  }

  const inFlight = dictionaryLoads.get(locale);
  if (inFlight) return inFlight;

  const operation = (async () => {
    const mod = locale === 'zh-CN'
      ? await import('./messages/zh-CN') as { dict: I18nDictionary }
      : locale === 'fr'
        ? await import('./messages/fr') as { dict: I18nDictionary }
      : locale === 'zh-TW'
        ? { dict: { ...enDict, ...(await import('./messages/zh-TW')).dict } as I18nDictionary }
        : locale === 'es'
          ? await import('./messages/es') as { dict: I18nDictionary }
          : locale === 'pt-BR'
            ? await import('./messages/pt-BR') as { dict: I18nDictionary }
            : locale === 'uk'
              ? await import('./messages/uk') as { dict: I18nDictionary }
              : locale === 'ko'
                ? await import('./messages/ko') as { dict: I18nDictionary }
                : locale === 'pl'
                  ? await import('./messages/pl') as { dict: I18nDictionary }
                  : locale === 'ja'
                    ? await import('./messages/ja') as { dict: I18nDictionary }
                    : { dict: enDict };
    dictionaries.set(locale, mod.dict);
    return mod.dict;
  })();
  dictionaryLoads.set(locale, operation);
  const release = () => {
    if (dictionaryLoads.get(locale) === operation) dictionaryLoads.delete(locale);
  };
  void operation.then(release, release);
  return operation;
}

export const useI18nStore = create<I18nState>()((set, get) => ({
  locale: DEFAULT_LOCALE,
  dictionary: enDict,
  loadingLocale: null,
  setLocale: (locale) => {
    const current = get();
    const cached = dictionaries.get(locale);
    if (current.locale === locale && current.loadingLocale !== locale && cached) {
      return Promise.resolve();
    }

    writeStoredLocale(locale);

    set({
      locale,
      dictionary: cached ?? current.dictionary,
      loadingLocale: cached ? null : locale,
    });

    if (cached) {
      return Promise.resolve();
    }

    return loadDictionary(locale).then((dictionary) => {
      if (get().locale !== locale) {
        return;
      }
      set({ dictionary, loadingLocale: null });
    }).catch((error) => {
      console.error(`[i18n] failed to load locale ${locale}`, error);
      if (get().locale === locale) {
        set({ dictionary: enDict, loadingLocale: null });
      }
    });
  },
}));

let localeStorageWindow: Window | undefined;
let unsubscribeDesktopLocale: (() => void) | undefined;
let applyingNativeLocale = false;
let localePublication = 0;
let pendingLocalePublication: number | undefined;
const applyNativeLocale = (locale: string): void => {
  applyingNativeLocale = true;
  try { void useI18nStore.getState().setLocale(normalizeLocale(locale)); }
  finally { applyingNativeLocale = false; }
};
const syncNativeLocale = (event: Event): void => {
  const detail = (event as CustomEvent<VarinDesktopEventMap['varin:locale-changed']>).detail;
  if (typeof detail?.locale !== 'string' || pendingLocalePublication !== undefined) return;
  applyNativeLocale(detail.locale);
};
const publishNativeLocale = (locale: Locale): void => {
  if (typeof window === 'undefined') return;
  const bridge = (window as Window & { __VARIN_DESKTOP__?: Partial<VarinDesktopBridge> }).__VARIN_DESKTOP__;
  if (applyingNativeLocale || !bridge?.invoke) return;
  const publication = ++localePublication;
  pendingLocalePublication = publication;
  void bridge.invoke('desktop_set_locale', { locale }).then(current => {
    if (pendingLocalePublication !== publication) return;
    pendingLocalePublication = undefined;
    if (typeof current === 'string') applyNativeLocale(current);
  }).catch(error => {
    if (pendingLocalePublication === publication) pendingLocalePublication = undefined;
    console.error('[i18n] Native language sync failed', error);
  });
};
const syncStoredLocale = (event: StorageEvent): void => {
  if (event.key !== LOCALE_STORAGE_KEY) return;
  // Read the latest saved value, not an older queued event's payload.
  const locale = readStoredLocale();
  if (locale) void useI18nStore.getState().setLocale(locale);
};

export function initializeLocale(): void {
  if (typeof window !== 'undefined' && localeStorageWindow !== window) {
    localeStorageWindow?.removeEventListener('storage', syncStoredLocale);
    localeStorageWindow?.removeEventListener('varin:locale-changed', syncNativeLocale);
    unsubscribeDesktopLocale?.();
    localeStorageWindow = window;
    localeStorageWindow.addEventListener('storage', syncStoredLocale);
    localeStorageWindow.addEventListener('varin:locale-changed', syncNativeLocale);
    unsubscribeDesktopLocale = useI18nStore.subscribe((next, previous) => {
      if (next.locale !== previous.locale) publishNativeLocale(next.locale);
    });
  }
  const previous = useI18nStore.getState().locale;
  void useI18nStore.getState().setLocale(detectInitialLocale());
  // setLocale can be a no-op for English or a warmed dictionary.
  if (typeof window !== 'undefined' && previous === useI18nStore.getState().locale) publishNativeLocale(previous);
}

export function formatMessage(dictionary: Partial<I18nDictionary>, key: I18nKey, params?: I18nParams): string {
  const template = dictionary[key] ?? enDict[key] ?? key;
  if (!params) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const value = params[rawKey.trim()];
    return value === null || value === undefined ? match : String(value);
  });
}

export type { I18nKey, Locale };
