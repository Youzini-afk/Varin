import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePluginInstallLink, publishPluginInstallIntent, consumePluginInstallIntent, subscribePluginInstallIntent } from '../src/plugin-install-intent.js';
const source = { kind: 'github-release', display: 'Example', specifier: 'example/mail' };
test('website deep links preserve public source and identity without authorizing install', () => {
  const url = `varin://extensions/install?source=${encodeURIComponent(JSON.stringify(source))}&extensionId=example.mail`;
  assert.deepEqual(parsePluginInstallLink(url), { source, extensionId: 'example.mail' });
  assert.deepEqual(parsePluginInstallLink(`https://app.example/?varin-plugin=${encodeURIComponent(JSON.stringify(source))}`), { source });
  assert.equal(parsePluginInstallLink(url + '&extensionId=' )?.extensionId, 'example.mail');
});
test('public install links cannot introduce local paths, credentials, or malformed identities', () => {
  for (const candidate of [{ ...source, kind: 'local', specifier: '/tmp/x' }, { ...source, kind: 'git', specifier: 'https://token@example.com/repo' }, { ...source, specifier: 'https://example.com/repo?token=secret' }]) {
    assert.equal(parsePluginInstallLink(`varin://extensions/install?source=${encodeURIComponent(JSON.stringify(candidate))}`), null);
  }
  assert.equal(parsePluginInstallLink(`varin://extensions/install?source=${encodeURIComponent(JSON.stringify(source))}&extensionId=`), null);
});
test('pending navigation survives page mount and is consumed only once', () => {
  let notified = 0; const unsubscribe = subscribePluginInstallIntent(() => notified++);
  publishPluginInstallIntent({ source }); assert.equal(notified, 1);
  assert.deepEqual(consumePluginInstallIntent(), { source }); assert.equal(consumePluginInstallIntent(), null); unsubscribe();
});

test('public npm links preserve scoped package semver ranges including spaces', () => {
  const rangeSource = { kind: 'npm', display: 'Research plugin', specifier: '@example/research@>=1.2.0 <2.0.0' };
  const link = `varin://extensions/install?source=${encodeURIComponent(JSON.stringify(rangeSource))}`;
  assert.deepEqual(parsePluginInstallLink(link), { source: rangeSource });
});
