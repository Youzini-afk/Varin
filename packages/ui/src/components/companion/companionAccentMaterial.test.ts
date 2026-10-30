import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { applyCompanionAccentPixels, CompanionAccentMaterial, validAccentSourceRegions } from './companionAccentMaterial';
import profile from './companionAccentProfile.json';
import type { CompanionPackage } from './sequencePackage';

const data = () => new Uint8ClampedArray(512 * 512 * 4);
const point = (pixels: Uint8ClampedArray, x: number, y: number, rgba: number[]) => pixels.set(rgba, (y * 512 + x) * 4);
const at = (pixels: Uint8ClampedArray, x: number, y: number) => [...pixels.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)];

test('material edits only admitted blue RGB, preserving alpha, eyes and neutral/warm materials', () => {
  const pixels = data();
  point(pixels, 2, 2, [63, 142, 243, 241]);
  point(pixels, 3, 2, [63, 142, 243, 255]); // Protected eye, deliberately identical blue.
  point(pixels, 4, 2, [240, 226, 222, 255]);
  point(pixels, 5, 2, [80, 76, 84, 255]);
  point(pixels, 6, 2, [241, 184, 157, 255]);
  point(pixels, 20, 20, [63, 142, 243, 255]);
  const before = pixels.slice();
  expect(applyCompanionAccentPixels(pixels, 512, 512, { allow: [[0, 0, 10, 10]], protect: [[3, 2, 4, 3]] })).toBe(1);
  expect(at(pixels, 2, 2)[3]).toBe(241);
  expect(at(pixels, 2, 2).slice(0, 3)).not.toEqual([63, 142, 243]);
  for (const [x, y] of [[3, 2], [4, 2], [5, 2], [6, 2], [20, 20]]) expect(at(pixels, x!, y!)).toEqual(at(before, x!, y!));
  expect(() => applyCompanionAccentPixels(pixels, 256, 512, { allow: [], protect: [] })).toThrow('registered');
});

test('fixed tonal response is deterministic, retains shadow order and does not normalize against other pixels', () => {
  const a = data(), b = data();
  point(a, 1, 1, [40, 80, 160, 255]); point(a, 2, 1, [80, 145, 240, 255]); b.set(a);
  point(b, 3, 1, [10, 80, 250, 255]);
  const regions = { allow: [[0, 0, 10, 10] as const], protect: [] };
  applyCompanionAccentPixels(a, 512, 512, regions); applyCompanionAccentPixels(b, 512, 512, regions);
  expect(at(a, 1, 1)).toEqual(at(b, 1, 1)); expect(at(a, 2, 1)).toEqual(at(b, 2, 1));
  expect(at(a, 1, 1)[2]).toBeLessThan(at(a, 2, 1)[2]!);
});

test('only frozen bundle/source identity is treated; two-frame cache reuses pixels and invalidates new bitmap generation', () => {
  const sources = Object.keys(profile.sources);
  const raw = readFileSync(new URL('../../../../web/public/companion-assets/bundle.json', import.meta.url));
  const selected = JSON.parse(raw.toString()) as { packages: CompanionPackage[] };
  expect(profile.bundleSHA256).toBe(createHash('sha256').update(raw).digest('hex'));
  expect(sources.sort()).toEqual([...new Set(selected.packages.flatMap(asset => asset.frames.map(frame => frame.sha256)))].sort());
  const material = new CompanionAccentMaterial();
  const stage = { getImageData: vi.fn(() => ({ width: 512, height: 512, data: data() })), putImageData: vi.fn() } as unknown as CanvasRenderingContext2D;
  const bitmap = {} as ImageBitmap;
  const sequence = (source: string) => ({ canvas: [512, 512], geometryReference: profile.geometryReference, frames: [{ sha256: source }] }) as CompanionPackage;
  expect(material.apply(stage, sequence(sources[0]!), bitmap, 0, null)).toBe(false);
  expect(material.apply(stage, sequence('unknown'), bitmap, 0, profile.bundleSHA256)).toBe(false);
  expect(material.apply(stage, {...sequence(sources[0]!),geometryReference:'another-skin'}, bitmap, 0, profile.bundleSHA256)).toBe(false);
  expect(material.apply(stage, sequence(sources[0]!), bitmap, 0, '0'.repeat(64))).toBe(false);
  expect(stage.getImageData).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) expect(material.apply(stage, sequence(sources[0]!), bitmap, 0, profile.bundleSHA256)).toBe(true);
  expect(stage.getImageData).toHaveBeenCalledTimes(1);
  material.apply(stage, sequence(sources[0]!), {} as ImageBitmap, 0, profile.bundleSHA256);
  expect(stage.getImageData).toHaveBeenCalledTimes(2);
  material.apply(stage, sequence(sources[1]!), bitmap, 0, profile.bundleSHA256);
  material.apply(stage, sequence(sources[2]!), bitmap, 0, profile.bundleSHA256);
  material.apply(stage, sequence(sources[0]!), bitmap, 0, profile.bundleSHA256);
  expect(stage.getImageData).toHaveBeenCalledTimes(5);
  material.clear(); material.apply(stage, sequence(sources[0]!), bitmap, 0, profile.bundleSHA256);
  expect(stage.getImageData).toHaveBeenCalledTimes(6);
});

test('source regions reject escaped/fractional or overlapping treatment rather than recolor twice', () => {
  expect(validAccentSourceRegions({allow:[[0,0,10,10],[10,0,20,10]],protect:[]})).toBe(true);
  for (const allow of [[[0,0,11,10],[10,0,20,10]], [[0,0,513,512]], [[0,0,1.5,10]], [[4,0,1,10]]]) {
    expect(validAccentSourceRegions({allow:allow as [number,number,number,number][],protect:[]})).toBe(false);
  }
  for (const invalid of [null, {}, { allow: [], protect: null }, { allow: [null], protect: [] }]) expect(validAccentSourceRegions(invalid)).toBe(false);
  for (const source of Object.values(profile.sources)) expect(validAccentSourceRegions(source)).toBe(true);
});
