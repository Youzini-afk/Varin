import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, type Locale } from './runtime';
import { formatMessage, initializeLocale, resetI18nDictionaryCacheForTests, useI18nStore } from './store';

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

  test('loads browser settings translations after the English fallback', async () => {
    for (const [locale, title] of Object.entries({ 'zh-CN': '浏览器', 'zh-TW': '瀏覽器', fr: 'Navigateur', ja: 'ブラウザー', es: 'Navegador', ko: '브라우저', pl: 'Przeglądarka', 'pt-BR': 'Navegador', uk: 'Браузер' })) {
      await useI18nStore.getState().setLocale(locale as Locale);
      const loaded = useI18nStore.getState().dictionary;
      expect(loaded['settings.browser.title'], locale).toBe(title);
      expect(formatMessage(loaded, 'settings.browser.edit', { name: '办公室' }), locale).toContain('办公室');
    }
    await useI18nStore.getState().setLocale('zh-CN');
    const dictionary = useI18nStore.getState().dictionary;
    expect(dictionary['settings.browser.title']).toBe('浏览器');
    expect(dictionary['settings.browser.addCdp']).toBe('添加 CDP 连接');
    expect(formatMessage(dictionary, 'settings.browser.edit', { name: '办公室' })).toBe('编辑 办公室');
  });

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

  test('shares the desktop language across origins, publishes user changes and does not echo native events', async () => {
    const values = new Map([[LOCALE_STORAGE_KEY, JSON.stringify({ locale: 'es' })]]);
    const invoke = vi.fn().mockResolvedValue(null);
    const target = Object.assign(new EventTarget(), {
      __VARIN_ELECTRON__: { locale: 'zh-TW' },
      __VARIN_DESKTOP__: { invoke },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal('window', target);
    try {
      initializeLocale();
      expect(useI18nStore.getState().locale).toBe('zh-TW');
      expect(invoke).toHaveBeenLastCalledWith('desktop_set_locale', { locale: 'zh-TW' });
      await useI18nStore.getState().setLocale('fr');
      expect(invoke).toHaveBeenLastCalledWith('desktop_set_locale', { locale: 'fr' });
      invoke.mockClear();
      target.dispatchEvent(Object.assign(new Event('varin:locale-changed'), { detail: { locale: 'ja' } }));
      expect(useI18nStore.getState().locale).toBe('ja');
      expect(JSON.parse(values.get(LOCALE_STORAGE_KEY)!)).toEqual({ locale: 'ja' });
      expect(invoke).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(useI18nStore.getState().loadingLocale).toBeNull());
    } finally {
      vi.unstubAllGlobals();
      resetStore();
    }
  });

  test('keeps the latest user choice while older native language changes are still completing', async () => {
    const completions: Array<(locale: string) => void> = [];
    const invoke = vi.fn(() => new Promise<string>(resolve => completions.push(resolve)));
    const target = Object.assign(new EventTarget(), { __VARIN_ELECTRON__: { locale: 'en' }, __VARIN_DESKTOP__: { invoke } });
    vi.stubGlobal('window', target);
    try {
      initializeLocale();
      completions.shift()!('en');
      await Promise.resolve();
      const loading = useI18nStore.getState().setLocale('fr');
      void useI18nStore.getState().setLocale('en');
      target.dispatchEvent(Object.assign(new Event('varin:locale-changed'), { detail: { locale: 'fr' } }));
      completions.shift()!('fr');
      await Promise.resolve();
      expect(useI18nStore.getState().locale).toBe('en');
      completions.shift()!('en');
      await loading;
      expect(useI18nStore.getState().locale).toBe('en');
    } finally {
      vi.unstubAllGlobals();
      resetStore();
    }
  });
});
