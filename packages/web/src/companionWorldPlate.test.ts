import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { readCompanionWorldPlate, verifyCompanionWorldPlate } from './companionWorldPlate';

const sha256 = 'a'.repeat(64);
const plate = { file: `world-stool-${sha256.slice(0, 16)}.png`, sha256 };
const bundle = (geometryEpoch = 'varin-canonical-v5-study') => ({
  geometryEpoch, worldStool: plate, packages: [{ geometryReference: geometryEpoch }],
});

describe('installed decorative world plate', () => {
  test.each(['varin-upright-v2', 'varin-canonical-v5-study'])('admits authored %s geometry', epoch => {
    expect(readCompanionWorldPlate(bundle(epoch))).toEqual(plate);
  });

  test('rejects unknown geometry even when all packages agree', () => {
    expect(() => readCompanionWorldPlate(bundle('unreviewed-future-geometry'))).toThrow('epoch');
  });

  test.each([undefined, [], [null], [{}], [{ geometryReference: 'varin-upright-v2' }]])(
    'rejects missing, empty, malformed or mismatched packages: %j', packages => {
      expect(() => readCompanionWorldPlate({ ...bundle(), packages })).toThrow('epoch');
    },
  );

  test.each([null, {}, { ...plate, sha256: 'invalid' },
    { ...plate, file: 'world-stool.png' }, { ...plate, file: `../${plate.file}` },
    { ...plate, file: `https://example.com/${plate.file}` },
    { ...plate, file: `world-stool-${'b'.repeat(16)}.png` }])('rejects nonlocal or nonimmutable plate: %j', worldStool => {
    expect(() => readCompanionWorldPlate({ ...bundle(), worldStool })).toThrow('epoch');
  });

  test('admits the installed bundle and verifies actual local PNG bytes, rejecting tampering', async () => {
    const base = new URL('../public/companion-assets/', import.meta.url);
    const installed = JSON.parse(await readFile(new URL('bundle.json', base), 'utf8'));
    const selected = readCompanionWorldPlate(installed);
    const bytes = new Uint8Array(await readFile(new URL(selected.file, base)));
    await expect(verifyCompanionWorldPlate(bytes.buffer, selected.sha256)).resolves.toBeUndefined();
    bytes[0] ^= 1;
    await expect(verifyCompanionWorldPlate(bytes.buffer, selected.sha256)).rejects.toThrow('hash mismatch');
  });
});
