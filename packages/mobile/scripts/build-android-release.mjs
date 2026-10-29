import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(mobileRoot, '../..');
const androidRoot = path.join(mobileRoot, 'android');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

export function androidReleaseVersion(version, env) {
  if (env.VARIN_RELEASE_REF && env.VARIN_RELEASE_REF !== `v${version}`) throw new Error('Release tag must match the source package version.');
  const value = env.VARIN_ANDROID_VERSION_CODE;
  const code = Number(value);
  // Android's install/update version contract, including the Play versionCode ceiling.
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error('Set VARIN_ANDROID_VERSION_CODE to a positive Android version code (at most 2100000000).');
  }
  return { name: version, code };
}

export function verifyAndroidPackage(badging, version) {
  const match = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging);
  if (!match || match[1] !== 'dev.varin.mobile' || Number(match[2]) !== version.code || match[3] !== version.name) {
    throw new Error('Built APK identity/version does not match the requested Varin release.');
  }
  if (/^application-debuggable(?:\s|$)/m.test(badging)) throw new Error('A debuggable APK cannot be staged as a release.');
}

function run(command, args, env, capture = false, cwd = mobileRoot) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal}).`);
  return result.stdout;
}

export function buildAndroidRelease(env = process.env) {
  const version = androidReleaseVersion(readJson(path.join(root, 'package.json')).version, env);
  if (readJson(path.join(root, 'packages/web/package.json')).version !== version.name) throw new Error('Web and product versions must agree.');
  const missing = ['VARIN_ANDROID_KEYSTORE_PATH', 'VARIN_ANDROID_KEYSTORE_PASSWORD', 'VARIN_ANDROID_KEY_ALIAS', 'VARIN_ANDROID_KEY_PASSWORD'].filter(name => !env[name]);
  if (missing.length) throw new Error(`Android release signing is not configured: ${missing.join(', ')}.`);
  const keystore = path.resolve(env.VARIN_ANDROID_KEYSTORE_PATH);
  if (!existsSync(keystore)) throw new Error('Android release keystore was not found.');
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT to the Android SDK.');
  const tools = path.join(sdk, 'build-tools', env.VARIN_ANDROID_BUILD_TOOLS || '36.0.0');
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const buildEnv = { ...env, VARIN_ANDROID_KEYSTORE_PATH: keystore, VARIN_ANDROID_VERSION_NAME: version.name, VARIN_ANDROID_VERSION_CODE: String(version.code) };

  run('bun', ['run', 'build'], buildEnv);
  // Sync Android only: regenerate plugin paths from this checkout's actual Bun install.
  run('bun', ['run', 'cap', 'sync', 'android'], buildEnv);
  // Invoke the original Gradle wrapper directly through Java on all platforms.
  run(java, ['-classpath', path.join(androidRoot, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', '--no-daemon', 'assembleRelease'], buildEnv, false, androidRoot);
  const apk = path.join(androidRoot, 'app/build/outputs/apk/release/app-release.apk');
  run(java, ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk], buildEnv);
  verifyAndroidPackage(run(path.join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk], buildEnv, true), version);

  const assets = path.join(mobileRoot, 'release-assets');
  mkdirSync(assets, { recursive: true });
  const name = `Varin-${version.name}-android.apk`;
  copyFileSync(apk, path.join(assets, name));
  const digest = createHash('sha256').update(readFileSync(apk)).digest('hex');
  writeFileSync(path.join(assets, `${name}.sha256`), `${digest}  ${name}\n`);
  console.log(`Verified Android release: ${name} (versionCode ${version.code})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildAndroidRelease(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
