import assert from 'node:assert/strict';
import test from 'node:test';
import { companionAssetBase } from '../src/companion-assets.js';

test('pins character, world props and decorative masks to the native-selected installed generation', () => {
  const version = 'a'.repeat(64);
  assert.equal(companionAssetBase(`varin-ui://app/companion.html?companionPack=varin&companionVersion=${version}`), `varin-ui://app/companion-assets/varin/${version}/`);
  assert.equal(companionAssetBase(`http://localhost:5173/companion.html?scene=1&companionPack=varin&companionVersion=${version}`), `varin-ui://app/companion-assets/varin/${version}/`);
  assert.equal(companionAssetBase(`varin-ui://app/companion.html?companionPack=../../other&companionVersion=${version}`), '/companion-assets/');
  assert.equal(companionAssetBase(undefined, true), '/companion-review-director/');
});

test('Tauri uses only the fixed private artwork protocol, never an arbitrary origin', () => {
  const version = 'a'.repeat(64);
  for (const origin of ['varin-companion://localhost', 'http://varin-companion.localhost']) {
    const url = `tauri://localhost/companion.html?companionPack=varin&companionVersion=${version}&companionAssetOrigin=${encodeURIComponent(origin)}`;
    assert.equal(companionAssetBase(url), `${origin}/varin/${version}/`);
  }
  assert.equal(companionAssetBase(`tauri://localhost/companion.html?companionPack=varin&companionVersion=${version}&companionAssetOrigin=https://attacker.example`), `varin-ui://app/companion-assets/varin/${version}/`);
});
