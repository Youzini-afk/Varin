import { expect, it } from 'vitest';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { browserConnectorArchive } from './browser-resource-routes.js';

it('downloads a loadable extension including native locale directories', async () => {
  const directory = fileURLToPath(new URL('../../../../browser-connector/extension/', import.meta.url));
  const zip = await browserConnectorArchive(directory);
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream as Readable) chunks.push(Buffer.from(chunk));
  const archive = new AdmZip(Buffer.concat(chunks));
  const manifest = JSON.parse(archive.readAsText('manifest.json'));
  expect(manifest.default_locale).toBe('en');
  expect(JSON.parse(archive.readAsText('_locales/en/messages.json')).name.message).toBe('Varin Browser');
  expect(JSON.parse(archive.readAsText('_locales/zh_CN/messages.json')).name.message).toBe('Varin 浏览器');
  expect(archive.getEntry('i18n.mjs')).not.toBeNull();
});
