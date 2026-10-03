import { beforeEach, describe, expect, test } from 'vitest';

import { detectInitialLocale, LOCALE_STORAGE_KEY } from './runtime';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

const installBrowserGlobals = ({
  languages,
  storedLocale,
}: {
  languages?: readonly string[];
  storedLocale?: string;
}) => {
  const storage = new Map<string, string>();
  if (storedLocale) {
    storage.set(LOCALE_STORAGE_KEY, JSON.stringify({ locale: storedLocale }));
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      language: languages?.[0] ?? 'en-US',
      languages: languages ? [...languages] : undefined,
    },
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    },
  });
};

const restoreProperty = (name: 'navigator' | 'window', descriptor: PropertyDescriptor | undefined) => {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
};

beforeEach(() => {
  restoreProperty('navigator', originalNavigator);
  restoreProperty('window', originalWindow);
});

describe('i18n runtime locale detection', () => {
  test('uses saved locale before system locale', () => {
    installBrowserGlobals({ languages: ['zh-CN'], storedLocale: 'fr' });

    expect(detectInitialLocale()).toBe('fr');
  });

  test('detects the browser language when no locale was saved', () => {
    installBrowserGlobals({ languages: ['zh-CN', 'en-US'] });

    expect(detectInitialLocale()).toBe('zh-CN');
  });

  test('falls through unsupported browser languages before using a supported one', () => {
    installBrowserGlobals({ languages: ['de-DE', 'pt-BR'] });

    expect(detectInitialLocale()).toBe('pt-BR');
  });
});
