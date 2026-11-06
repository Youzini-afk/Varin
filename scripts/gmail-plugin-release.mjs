import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Fail before building/publishing when the plugin's source identity and release tag disagree. */
export function validateGmailRelease({ eventName, refType, refName, manifest, metadata }) {
  if (manifest.id !== 'varin.gmail' || metadata.name !== '@varin/plugin-gmail'
    || typeof manifest.version !== 'string' || !manifest.version || manifest.version !== metadata.version) {
    throw new Error('Gmail package and manifest identity/version must agree');
  }
  if (eventName === 'workflow_dispatch') return { publish: false };
  if (eventName !== 'push' || refType !== 'tag' || refName !== `gmail-v${manifest.version}`) {
    throw new Error('Gmail publication requires a pushed gmail-v tag matching the manifest version');
  }
  return { publish: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = new URL('../examples/extensions/gmail/', import.meta.url);
  validateGmailRelease({ eventName: process.env.GITHUB_EVENT_NAME, refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    manifest: JSON.parse(readFileSync(new URL('varin.extension.json', directory), 'utf8')),
    metadata: JSON.parse(readFileSync(new URL('package.json', directory), 'utf8')) });
}
