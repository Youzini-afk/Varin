import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extensionI18n } from './localization.mjs';

test('native locale catalogs cover the popup, manifest and substitution contract', async () => {
  const extension = new URL('../extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extension), 'utf8'));
  const html = await readFile(new URL('popup.html', extension), 'utf8');
  const base = JSON.parse(await readFile(new URL(`_locales/${manifest.default_locale}/messages.json`, extension), 'utf8'));
  const referenced = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g), ...html.matchAll(/data-i18n="(\w+)"/g)].map(match => match[1]);
  for (const key of referenced) assert.ok(base[key]?.message, key);
  for (const locale of await readdir(new URL('_locales/', extension))) {
    const catalog = JSON.parse(await readFile(new URL(`_locales/${locale}/messages.json`, extension), 'utf8'));
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(base).sort(), locale);
    for (const [key, entry] of Object.entries(catalog)) {
      assert.ok(entry.message.trim(), `${locale}: ${key}`);
      assert.deepEqual(entry.placeholders, base[key].placeholders, `${locale}: ${key}`);
      assert.deepEqual(entry.message.match(/\$\w+\$/g), base[key].message.match(/\$\w+\$/g), `${locale}: ${key}`);
    }
    assert.ok(extensionI18n(locale).getMessage('paired', 'Office').includes('Office'));
  }
});
