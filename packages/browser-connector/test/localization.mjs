import { readFileSync } from 'node:fs';

export function extensionI18n(locale = 'en') {
  const catalog = JSON.parse(readFileSync(new URL(`../extension/_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
  return {
    getUILanguage: () => locale.replace('_', '-'),
    getMessage: (key, substitutions) => {
      const entry = catalog[key];
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return entry?.message.replace(/\$(\w+)\$/g, (_, name) => values[Number(entry.placeholders[name].content.slice(1)) - 1]) || '';
    },
  };
}
