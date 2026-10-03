import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dict as enDict } from './en';
import { settingsDict as enSettingsDict } from './en.settings';
import { dict as esDict } from './es';
import { dict as frDict } from './fr';
import { dict as jaDict } from './ja';
import { dict as koDict } from './ko';
import { dict as plDict } from './pl';
import { dict as ptBrDict } from './pt-BR';
import { dict as ukDict } from './uk';
import { dict as zhCnDict } from './zh-CN';
import { dict as zhTwDict } from './zh-TW';

type MessageDict = Record<string, string>;

const localeDictionaries = {
  fr: frDict,
  ja: jaDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
  es: esDict,
  'pt-BR': ptBrDict,
  ko: koDict,
  pl: plDict,
  uk: ukDict,
} satisfies Record<string, MessageDict>;

const englishDict: MessageDict = enDict;

const placeholderPattern = /\{[a-zA-Z0-9_]+\}/g;
const messageKeyPattern = /^\s*['"]([^'"]+\.[^'"]+)['"]\s*:/gm;
const messagesDir = dirname(fileURLToPath(import.meta.url));

const localeFiles = {
  'zh-CN': ['zh-CN.ts', 'zh-CN.settings.ts'],
  'zh-TW': ['zh-TW.ts', 'zh-TW.settings.ts'],
  es: ['es.ts', 'es.settings.ts'],
  'pt-BR': ['pt-BR.ts', 'pt-BR.settings.ts'],
  ko: ['ko.ts', 'ko.settings.ts'],
  pl: ['pl.ts', 'pl.settings.ts'],
  uk: ['uk.ts', 'uk.settings.ts'],
} satisfies Record<string, readonly string[]>;

const settingsFiles = {
  'zh-CN': 'zh-CN.settings.ts',
  'zh-TW': 'zh-TW.settings.ts',
  es: 'es.settings.ts',
  'pt-BR': 'pt-BR.settings.ts',
  ko: 'ko.settings.ts',
  pl: 'pl.settings.ts',
  uk: 'uk.settings.ts',
} satisfies Record<string, string>;

function sortedKeys(dict: MessageDict): string[] {
  return Object.keys(dict).sort();
}

function placeholders(value: string): string[] {
  return [...new Set(value.match(placeholderPattern) ?? [])].sort();
}

function explicitKeysFromFile(fileName: string): string[] {
  const source = readFileSync(join(messagesDir, fileName), 'utf8');
  return [...source.matchAll(messageKeyPattern)].map((match) => match[1]).sort();
}

function explicitKeysFromFiles(fileNames: readonly string[]): string[] {
  return [...new Set(fileNames.flatMap(explicitKeysFromFile))].sort();
}

function diffKeys(expected: string[], actual: string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  return {
    missing: expected.filter((key) => !actualSet.has(key)),
    extra: actual.filter((key) => !expectedSet.has(key)),
  };
}

describe('i18n message parity', () => {
  test('locale dictionaries define every English key explicitly', () => {
    const englishKeys = sortedKeys(enDict);
    const failures: Record<string, { missing: string[]; extra: string[] }> = {};

    for (const [locale, fileNames] of Object.entries(localeFiles)) {
      const diff = diffKeys(englishKeys, explicitKeysFromFiles(fileNames));
      if (diff.missing.length > 0 || diff.extra.length > 0) {
        failures[locale] = diff;
      }
    }

    expect(failures).toEqual({});
  });

  test('settings split files stay aligned with English settings keys', () => {
    const englishSettingsKeys = sortedKeys(enSettingsDict);
    const failures: Record<string, { missing: string[]; extra: string[] }> = {};

    for (const [locale, fileName] of Object.entries(settingsFiles)) {
      const diff = diffKeys(englishSettingsKeys, explicitKeysFromFile(fileName));
      if (diff.missing.length > 0 || diff.extra.length > 0) {
        failures[locale] = diff;
      }
    }

    expect(failures).toEqual({});
  });


  test('locale placeholders match English placeholders', () => {
    const failures: Record<string, Record<string, { expected: string[]; actual: string[] }>> = {};

    for (const [locale, dict] of Object.entries(localeDictionaries)) {
      for (const key of sortedKeys(enDict)) {
        const localeDict: MessageDict = dict;
        const expected = placeholders(englishDict[key] ?? '');
        const actual = placeholders(localeDict[key] ?? '');
        const missing = expected.filter((placeholder) => !actual.includes(placeholder));
        if (missing.length > 0) {
          failures[locale] ??= {};
          failures[locale][key] = { expected, actual };
        }
      }
    }

    expect(failures).toEqual({});
  });
});
