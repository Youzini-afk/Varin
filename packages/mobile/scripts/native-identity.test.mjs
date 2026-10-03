import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (...segments) => readFileSync(join(mobileRoot, ...segments), 'utf8');

test('native shells use the Varin application identity', () => {
  assert.match(read('capacitor.config.ts'), /appId: 'dev\.varin\.mobile'/);
  assert.match(read('capacitor.config.ts'), /appName: 'Varin'/);
  assert.match(read('android', 'app', 'build.gradle'), /applicationId "dev\.varin\.mobile"/);
  assert.match(read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), /<string name="custom_url_scheme">varin<\/string>/);
  assert.match(read('android', 'app', 'src', 'main', 'AndroidManifest.xml'), /android\.intent\.category\.BROWSABLE/);
  assert.ok(existsSync(join(mobileRoot, 'android', 'app', 'src', 'main', 'java', 'dev', 'varin', 'mobile', 'MainActivity.java')));

  const project = read('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.varin\.mobile;/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.varin\.mobile\.widget;/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.varin\.mobile\.notification-service;/);
  assert.match(project, /path = VarinWidget;/);
  assert.match(project, /path = VarinNotificationService;/);
  assert.match(project, /path = VarinWidgets\.swift;/);
  assert.match(project, /path = VarinControl\.swift;/);
  assert.match(read('ios', 'App', 'App', 'Info.plist'), /<string>varin<\/string>/);
  for (const relative of [
    ['ios', 'App', 'App', 'App.entitlements'],
    ['ios', 'App', 'VarinWidget', 'VarinWidget.entitlements'],
    ['ios', 'App', 'VarinNotificationService', 'VarinNotificationService.entitlements'],
  ]) {
    assert.match(read(...relative), /group\.dev\.varin\.mobile/);
  }
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'VarinWidget.xcscheme')));
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'VarinWidget', 'VarinWidgets.swift')));
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'VarinWidget', 'VarinControl.swift')));
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'VarinNotificationService', 'NotificationService.swift')));

  const definitions = new Set(
    [...project.matchAll(/^\s*([A-F0-9]{24}) \/\*.*\*\/ = \{/gm)].map((match) => match[1]),
  );
  const brokenReferences = [];
  for (const match of project.matchAll(/\b(buildConfigurationList|fileRef|productReference|target|targetProxy|remoteGlobalIDString) = ([A-F0-9]+);/g)) {
    const [, field, identifier] = match;
    if (identifier.length !== 24 || !definitions.has(identifier)) {
      brokenReferences.push(`${field}:${identifier}`);
    }
  }
  assert.deepEqual(brokenReferences, []);
});
