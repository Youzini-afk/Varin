import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_LOCALE } from './runtime';
import { resetI18nDictionaryCacheForTests, useI18nStore } from './store';

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
