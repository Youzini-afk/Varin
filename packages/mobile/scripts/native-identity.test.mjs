import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import config from '../capacitor.config.ts';

const mobileRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (...segments) => readFileSync(join(mobileRoot, ...segments), 'utf8');
// Use the parsers shipped with the native project owner, without another parser dependency.
const require = createRequire(import.meta.url);
const capacitorRequire = createRequire(require.resolve('@capacitor/cli'));
const { parseStringPromise } = capacitorRequire('xml2js');
const plist = capacitorRequire('plist');
const xcode = capacitorRequire('xcode');

test('Android and Capacitor retain the installed identity and a browsable Varin deep link', async () => {
  assert.equal(config.appId, 'dev.varin.mobile');
  assert.equal(config.appName, 'Varin');
  assert.match(read('android', 'app', 'build.gradle'), /applicationId "dev\.varin\.mobile"/);
  const strings = (await parseStringPromise(read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'))).resources.string;
  const values = Object.fromEntries(strings.map(value => [value.$.name, value._]));
  const manifest = (await parseStringPromise(read('android', 'app', 'src', 'main', 'AndroidManifest.xml'))).manifest;
  const activity = manifest.application[0].activity.find(value => value.$['android:name'] === '.MainActivity');
  assert.equal(activity.$['android:exported'], 'true');
  const link = activity['intent-filter'].find(value => value.action.some(action => action.$['android:name'] === 'android.intent.action.VIEW'));
  assert(link.category.some(value => value.$['android:name'] === 'android.intent.category.BROWSABLE'));
  const schemeResource = link.data[0].$['android:scheme'].replace('@string/', '');
  assert.equal(values[schemeResource], 'varin');
  assert(existsSync(join(mobileRoot, 'android/app/src/main/java', ...config.appId.split('.'), 'MainActivity.java')));
});

test('iOS targets bind their installed bundle identities and the shared widget container', () => {
  const project = xcode.project(join(mobileRoot, 'ios/App/App.xcodeproj/project.pbxproj'));
  project.parseSync();
  const objects = project.hash.project.objects;
  const entries = Object.values(objects.PBXNativeTarget).filter(value => typeof value === 'object');
  const identities = { App: 'dev.varin.mobile', VarinWidget: 'dev.varin.mobile.widget', VarinNotificationService: 'dev.varin.mobile.notification-service' };
  for (const [name, identity] of Object.entries(identities)) {
    const target = entries.find(value => value.name === name);
    assert(target, `Missing native target ${name}`);
    const configurations = objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations;
    assert(configurations.length > 0);
    for (const { value } of configurations) {
      const settings = objects.XCBuildConfiguration[value].buildSettings;
      assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, identity);
      const entitlements = plist.parse(read('ios', 'App', settings.CODE_SIGN_ENTITLEMENTS.replaceAll('"', '')));
      assert.deepEqual(entitlements['com.apple.security.application-groups'], ['group.dev.varin.mobile']);
    }
  }
  const info = plist.parse(read('ios', 'App', 'App', 'Info.plist'));
  assert.deepEqual(info.CFBundleURLTypes.flatMap(value => value.CFBundleURLSchemes), ['varin']);

  // A valid-looking identifier in a comment cannot satisfy a broken Xcode object reference.
  const references = new Set(['buildConfigurationList', 'fileRef', 'productReference', 'target', 'targetProxy', 'remoteGlobalIDString']);
  const definitions = new Set(Object.values(objects).flatMap(section => Object.keys(section)));
  for (const section of Object.values(objects)) for (const object of Object.values(section)) {
    if (typeof object !== 'object') continue;
    for (const [field, identifier] of Object.entries(object)) if (references.has(field)) {
      assert(definitions.has(identifier), `Broken Xcode ${field}: ${identifier}`);
    }
  }
});
