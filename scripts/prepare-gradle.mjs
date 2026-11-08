import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadBuildAsset } from './download-build-asset.mjs';

const properties = Object.fromEntries((await readFile('packages/mobile/android/gradle/wrapper/gradle-wrapper.properties', 'utf8'))
  .split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/\\:/g, ':')];
  }));
const url = properties.distributionUrl;
const filename = path.posix.basename(new URL(url).pathname);
// Gradle Wrapper's PathAssembler uses MD5(url) encoded in base 36. Seed only
// its ZIP input; the real wrapper still verifies, extracts and launches Gradle.
const hash = BigInt(`0x${createHash('md5').update(url).digest('hex')}`).toString(36);
const cache = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
const archive = path.join(cache, properties.zipStorePath, filename.replace(/\.zip$/, ''), hash, filename);
if (!existsSync(`${archive}.ok`)) {
  const expected = properties.distributionSha256Sum;
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Gradle distribution must have its pinned SHA-256');
  const digest = async () => {
    if (!existsSync(archive)) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    return hash.digest('hex');
  };
  if (await digest() !== expected) await downloadBuildAsset(url, archive);
  if (await digest() !== expected) throw new Error('Gradle distribution checksum mismatch');
  console.log('[build-download] Gradle Wrapper archive is ready');
}
