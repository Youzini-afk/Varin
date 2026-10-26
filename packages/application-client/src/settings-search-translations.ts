import { SETTINGS_CATALOG } from './settings-catalog.js';

// The same static dictionaries power UI labels and Host discovery. Load them only
// for textual searches; category browsing and ordinary clients need no locale data.
let index: Promise<ReadonlyMap<string, string>> | undefined;
export function settingsSearchTranslations(): Promise<ReadonlyMap<string, string>> {
  return index ??= Promise.all([
    import('./settings-locales/en.js'), import('./settings-locales/es.js'),
    import('./settings-locales/fr.js'), import('./settings-locales/ja.js'),
    import('./settings-locales/ko.js'), import('./settings-locales/pl.js'),
    import('./settings-locales/pt-BR.js'), import('./settings-locales/uk.js'),
    import('./settings-locales/zh-CN.js'), import('./settings-locales/zh-TW.js'),
  ]).then(modules => {
    const dictionaries = modules.map(module => module.settingsDict as Record<string, string>);
    return new Map(SETTINGS_CATALOG.map(entry => [entry.id, dictionaries.flatMap(dict =>
      [dict[entry.ui.titleKey], entry.ui.descriptionKey ? dict[entry.ui.descriptionKey] : undefined]
        .filter((text): text is string => Boolean(text))).join(' ')]));
  }).catch(error => { index = undefined; throw error; });
}
