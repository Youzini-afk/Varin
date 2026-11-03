import { expect, it } from 'vitest';
import { nativeMigrationReceipt } from './native-migration-receipt.js';
const base = { schema: 1, protocol: 1, sourceSha: 'a'.repeat(40), sourceVersion: '1', attemptComplete: true,
  sourceRetained: true, browserStatus: 'not-migrated', browserRequiresLogin: true };
it('stores application credential outcomes without claiming browser compatibility or retaining secrets', () => {
  const receipt = nativeMigrationReceipt({ ...base, credentials: [{ slot: 'openaiApiKey', status: 'imported', value: 'synthetic-secret' }],
    companionFailures: [{ id: 'varin', reason: 'asset-integrity', value: 'synthetic-private' }] });
  expect(JSON.stringify(receipt)).not.toContain('synthetic-');
  expect(receipt).toMatchObject({ credentialsComplete: true, browserStatus: 'not-migrated', browserRequiresLogin: true, sourceRetained: true,
    companionFailures: [{ id: 'varin', reason: 'asset-integrity' }] });
  expect(receipt).not.toHaveProperty('cookiesComplete');
  expect(receipt).not.toHaveProperty('origins');
});
it('rejects unknown or duplicate credential slots and old browser transfer receipts', () => {
  expect(() => nativeMigrationReceipt({ ...base, credentials: [{ slot: 'arbitrary-secret', status: 'imported' }] })).toThrow();
  expect(() => nativeMigrationReceipt({ ...base, credentials: [{ slot: 'sttApiKey', status: 'imported' }, { slot: 'sttApiKey', status: 'retained' }] })).toThrow();
  for (const extra of [{ browserStatus: 'available' }, { browserRequiresLogin: false }, { cookies: [] }, { origins: [] }, { browserStorage: {} }])
    expect(() => nativeMigrationReceipt({ ...base, credentials: [], ...extra })).toThrow();
});
it('commits application migration at the existing settings owner and preserves unrelated settings on rejected browser data', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const { createDesktopSettingsOwner } = await import('../../desktop-settings.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-application-migration-'));
  try {
    const file = path.join(directory, 'settings.json');
    await writeFile(file, JSON.stringify({ unrelated: 'retain', desktopFrontendMigration: { stage: 'imported', credentialsComplete: false } }));
    const owner = createDesktopSettingsOwner(file);
    await owner('nativeMigrationComplete', { ...base, credentials: [{ slot: 'openaiApiKey', status: 'retained' }] });
    expect(await owner('nativeMigrationRead')).toMatchObject({ credentialsComplete: true, browserStatus: 'not-migrated' });
    const committed = await readFile(file, 'utf8');
    expect(JSON.parse(committed)).toMatchObject({ unrelated: 'retain', desktopFrontendMigration: { credentialsComplete: true } });
    await expect(owner('nativeMigrationComplete', { ...base, credentials: [], cookies: [{ value: 'never-copy' }] })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(committed);
    await expect(owner('nativeMigrationCookiePrepare', {})).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('retains application credential failures and companion recovery without browser import work', () => {
  expect(nativeMigrationReceipt({ ...base, credentials: [{ slot: 'sttApiKey', status: 'failed' }] }))
    .toMatchObject({ credentialsComplete: false, browserStatus: 'not-migrated', browserRequiresLogin: true });
});
