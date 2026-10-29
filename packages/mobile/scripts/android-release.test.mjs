import assert from 'node:assert/strict';
import test from 'node:test';
import { androidReleaseVersion, buildAndroidRelease, verifyAndroidPackage } from './build-android-release.mjs';

test('Android releases use the product version and a retained, monotonic workflow build number', () => {
  assert.deepEqual(androidReleaseVersion('0.9.33', { VARIN_RELEASE_REF: 'v0.9.33', VARIN_ANDROID_VERSION_CODE: '142' }), { name: '0.9.33', code: 142 });
  assert.throws(() => androidReleaseVersion('0.9.33', { VARIN_RELEASE_REF: 'v0.9.32', VARIN_ANDROID_VERSION_CODE: '142' }), /tag must match/);
  for (const value of ['', '0', '-1', '1.5', 'abc', '2100000001']) {
    assert.throws(() => androidReleaseVersion('0.9.33', { VARIN_ANDROID_VERSION_CODE: value }), /version code/);
  }
});

test('APK metadata rejects the wrong identity, stale versions and debug builds', () => {
  const version = { name: '0.9.33', code: 142 };
  const badging = "package: name='dev.varin.mobile' versionCode='142' versionName='0.9.33' platformBuildVersionName='16'\nsdkVersion:'24'\n";
  verifyAndroidPackage(badging, version);
  for (const invalid of [badging.replace('dev.varin.mobile', 'other.app'), badging.replace("versionCode='142'", "versionCode='1'"), badging.replace("versionName='0.9.33'", "versionName='0.1.0'"), `${badging}application-debuggable\n`, '']) {
    assert.throws(() => verifyAndroidPackage(invalid, version));
  }
});

test('missing release credentials fail before any build and identify only the missing settings', () => {
  assert.throws(() => buildAndroidRelease({ VARIN_ANDROID_VERSION_CODE: '142' }), error => {
    assert.match(error.message, /signing is not configured/);
    assert.match(error.message, /VARIN_ANDROID_KEYSTORE_PATH/);
    return true;
  });
});
