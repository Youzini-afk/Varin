import { normalizeLocale, type Locale } from '@varin/application-client/locale';
import type { MenuItemConstructorOptions } from 'electron';

// Shared inert catalog consumed by both native shells. No React or Host owner.
import nativeCatalog from '../application-client/src/native-messages.json' with { type: 'json' };
const { translatedLocales, messages } = nativeCatalog;

export type NativeMessage = keyof typeof messages;
let locale: Locale = 'en';
export const getNativeLocale = (): Locale => locale;
export const setNativeLocale = (value: string): void => { locale = normalizeLocale(value); };
export const nativeText = (key: NativeMessage, params?: Record<string, string | number>): string => {
  const index = translatedLocales.findIndex(candidate => candidate === locale);
  const template = index < 0 ? key : messages[key][index]!;
  return params ? template.replace(/\{([^{}]+)\}/g, (match, name: string) => params[name] === undefined ? match : String(params[name])) : template;
};

const roleMessages = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', selectAll: 'Select All',
  services: 'Services', hide: 'Hide Varin', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit Varin', close: 'Close',
  minimize: 'Minimize', zoom: 'Zoom', reload: 'Reload', forceReload: 'Force Reload', togglefullscreen: 'Toggle Full Screen',
} as const satisfies Partial<Record<NonNullable<MenuItemConstructorOptions['role']>, NativeMessage>>;

// Only for templates owned by Varin: user titles and content must not be
// translated by matching their text. Explicit labels keep native roles and
// their OS behavior while following the application's language.
export const localizeNativeMenu = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => template.map(item => {
  const key = item.label && Object.hasOwn(messages, item.label) ? item.label as NativeMessage
    : !item.label && item.role ? roleMessages[item.role as keyof typeof roleMessages] : undefined;
  return { ...item, ...(key ? { label: nativeText(key) } : {}),
    ...(Array.isArray(item.submenu) ? { submenu: localizeNativeMenu(item.submenu) } : {}) };
});

const contextMessages = {
  learnSpelling: 'Learn Spelling', lookUpSelection: 'Look Up “{selection}”', searchWithGoogle: 'Search with Google', dictionarySuggestions: 'No Guesses Found',
  cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', selectAll: 'Select All',
  saveImage: 'Save Image', saveImageAs: 'Save Image As…', saveVideo: 'Save Video', saveVideoAs: 'Save Video As…',
  copyLink: 'Copy Link', saveLinkAs: 'Save Link As…', copyImage: 'Copy Image', copyImageAddress: 'Copy Image Address',
  copyVideoAddress: 'Copy Video Address', copyVideoFrame: 'Copy Video Frame', saveVideoFrameAs: 'Save Video Frame As…',
  pictureInPicture: 'Picture in Picture', inspect: 'Inspect Element', services: 'Services',
} as const satisfies Record<string, NativeMessage>;

// electron-context-menu reads labels on each invocation. Getters pick up the
// current locale without reinstalling handlers on every WebContents.
export const nativeContextMenuLabels = Object.defineProperties({}, Object.fromEntries(
  Object.entries(contextMessages).map(([id, key]) => [id, { enumerable: true, get: () => nativeText(key) }]),
)) as Record<keyof typeof contextMessages, string>;
