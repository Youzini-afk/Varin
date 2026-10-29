import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY } from './runtime';
import { initializeLocale, resetI18nDictionaryCacheForTests, useI18nStore } from './store';

const defaultDictionary = useI18nStore.getState().dictionary;

const resetStore = () => {
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

describe('i18n store', () => {
  beforeEach(resetStore);

  test('retries loading the active locale when it is not cached', async () => {
    useI18nStore.setState({
      locale: 'es',
      dictionary: defaultDictionary,
      loadingLocale: null,
    });

    try {
      const loaded = useI18nStore.getState().setLocale('es');

      expect(useI18nStore.getState().loadingLocale).toBe('es');
      await loaded;
      expect(useI18nStore.getState().loadingLocale).toBeNull();
    } finally {
      resetStore();
    }
  });

  test('initializes from saved language and follows another window without polling', async () => {
    const values = new Map([[LOCALE_STORAGE_KEY, JSON.stringify({ locale: 'zh-CN' })]]);
    const target = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal('window', target);
    const notify = (key: string) => target.dispatchEvent(Object.assign(new Event('storage'), { key }));
    try {
      initializeLocale();
      initializeLocale();
      await vi.waitFor(() => expect(useI18nStore.getState().loadingLocale).toBeNull());
      expect(useI18nStore.getState().locale).toBe('zh-CN');
      expect(useI18nStore.getState().dictionary['companion.passthroughUnsupported'])
        .not.toBe(defaultDictionary['companion.passthroughUnsupported']);

      values.set(LOCALE_STORAGE_KEY, JSON.stringify({ locale: 'en' }));
      notify('unrelated-setting');
      expect(useI18nStore.getState().locale).toBe('zh-CN');
      notify(LOCALE_STORAGE_KEY);
      expect(useI18nStore.getState().locale).toBe('en');
      expect(useI18nStore.getState().dictionary).toBe(defaultDictionary);
      values.set(LOCALE_STORAGE_KEY, 'invalid');
      notify(LOCALE_STORAGE_KEY);
      expect(useI18nStore.getState().locale).toBe('en');
    } finally {
      vi.unstubAllGlobals();
      resetStore();
    }
  });

  test('loads the french dictionary', async () => {
    try {
      const loaded = useI18nStore.getState().setLocale('fr');

      expect(useI18nStore.getState().loadingLocale).toBe('fr');
      await loaded;
      expect(useI18nStore.getState().dictionary['common.language.french']).toBe('Français');
      expect(useI18nStore.getState().dictionary['settings.varin.pluginSettings.aft.section.core'])
        .toBe('Comportement principal de l’édition');
    } finally {
      resetStore();
    }
  });
});
