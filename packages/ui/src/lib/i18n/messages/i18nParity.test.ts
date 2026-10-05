import { describe, expect, test } from 'vitest';
import { formatMessage, type I18nKey } from '../store';
import { dict as en } from './en';
import { dict as fr } from './fr';
import { dict as ja } from './ja';
import { dict as es } from './es';
import { dict as ko } from './ko';
import { dict as pl } from './pl';
import { dict as ptBR } from './pt-BR';
import { dict as uk } from './uk';
import { dict as zhCN } from './zh-CN';
import { dict as zhTW } from './zh-TW';

// Locale files may inherit English entries. Validate the messages consumers
// actually receive, including fallback, rather than how their source is written.
describe('runtime messages', () => {
  test('locale messages retain interpolated parameters, including inherited entries', () => {
    const failures: string[] = [];
    for (const [locale, dictionary] of Object.entries({ en, fr, ja, es, ko, pl, ptBR, uk, zhCN, zhTW })) {
      for (const [key, source] of Object.entries(en)) {
        const names = [...new Set([...source.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]))];
        const params = Object.fromEntries(names.map(name => [name, `value-${name}`]));
        const message = formatMessage(dictionary, key as I18nKey, params);
        if (names.some(name => !message.includes(params[name]))) {
          failures.push(`${locale}:${key}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
