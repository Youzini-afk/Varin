import { expect, it } from 'vitest';
import { SceneCharacterMaskCache, inverseCharacterMaskSvg, type SceneCharacterMask, type SceneCharacterMaskEnvironment } from './sceneCharacterMask';
const epoch = 'a'.repeat(64), otherEpoch = 'b'.repeat(64);
const drawing = (frameIndex = 0, value = epoch) => ({ epoch: value, packageId: 'selected', frameIndex });
const bundle = (page = 'atlas-000.png', candidateOnly = false) => ({ candidateOnly, packages: [{ id: 'selected', canvas: [4, 4], geometryReference: 'upright', stage: 'motion-candidate', reviewStatus: candidateOnly ? 'candidate' : 'accepted', entryPose: 'rest', exitPose: 'rest', pages: [{ file: page }, { file: 'atlas-001.png' }], frames: [
 { page: 0, rect: [1, 2, 2, 2], offset: [1, 1], durationMs: 100 },
 { page: 0, rect: [2, 2, 2, 2], offset: [1, 1], durationMs: 100 },
 { page: 1, rect: [1, 2, 2, 2], offset: [1, 1], durationMs: 100 },
] }] });
function setup(value = bundle(), occlusion?: unknown, digest = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes) === 'alpha' ? 'c'.repeat(64) : epoch) {
 const requests: string[] = [], disposed: string[] = [], decode: Array<() => void> = [], updates: Array<SceneCharacterMask | null> = [];
 const environment: SceneCharacterMaskEnvironment = {
  fetch: async input => { requests.push(input); return input.endsWith('bundle.json') ? new Response(JSON.stringify(value))
    : input.endsWith('occlusion.json') ? new Response(JSON.stringify(occlusion ?? null), { status: occlusion ? 200 : 404 })
      : new Response(input.includes('occlusion-') ? 'alpha' : 'png'); },
  sha256: async bytes => digest(bytes),
  decode: () => new Promise(resolve => { const href = `blob:atlas-${decode.length}`; decode.push(() => resolve({ href, width: 8, height: 8, dispose: () => disposed.push(href) })); }),
 };
 const cache = new SceneCharacterMaskCache('selected', value => updates.push(value), environment);
 return { cache, requests, disposed, decode, updates, environment };
}
// Manifest and page reads settle through real Response bodies, not only microtasks.
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
it('admits only the exact bundle hash/package/frame and fixed local resource names', async () => {
 const s = setup(); expect(await s.cache.setDrawing(drawing(0, otherEpoch))).toBeNull(); expect(s.requests).toEqual(['/companion-assets/bundle.json']);
 expect(await s.cache.setDrawing({ ...drawing(), packageId: '../secret' })).toBeNull(); expect(s.decode).toHaveLength(0);
 const unsafe = setup(bundle('../atlas.png')); expect(await unsafe.cache.setDrawing(drawing())).toBeNull(); expect(unsafe.decode).toHaveLength(0);
 const candidate = setup(bundle('atlas.png', true)); expect(await candidate.cache.setDrawing(drawing())).toBeNull();
});
it('waits for cold decode then commits verified same-page exposure synchronously', async () => {
 const s = setup(), first = s.cache.setDrawing(drawing()); await flush(); expect(s.cache.current).toBeNull(); expect(s.decode).toHaveLength(1);
 s.decode[0]!(); expect((await first)?.rect).toEqual([1, 2, 2, 2]);
 const second = s.cache.setDrawing(drawing(1)); expect(s.cache.current?.rect).toEqual([2, 2, 2, 2]); expect((await second)?.rect).toEqual([2, 2, 2, 2]);
 expect(s.decode).toHaveLength(1); expect(s.requests.filter(x => x.includes('.png'))).toHaveLength(2); // Current + next-page prediction only.
 s.cache.clear(); expect(s.cache.current).toBeNull(); expect(s.disposed).toHaveLength(1);
});
it('shares a pending page without publishing the earlier exposure', async () => {
 const s = setup(), first = s.cache.setDrawing(drawing()); await flush(); const second = s.cache.setDrawing(drawing(1)); await flush();
 s.decode[0]!(); expect(await first).toBeNull(); expect((await second)?.rect).toEqual([2, 2, 2, 2]); expect(s.updates.filter(Boolean)).toHaveLength(1); expect(s.decode).toHaveLength(1);
});
it('revokes late superseded pages and cannot revive a hidden or disposed surface', async () => {
 const s = setup(), first = s.cache.setDrawing(drawing()); await flush(); const second = s.cache.setDrawing(drawing(2)); await flush();
 expect(s.decode).toHaveLength(2); s.decode[0]!(); expect(await first).toBeNull(); expect(s.disposed).toContain('blob:atlas-0');
 s.cache.clear(); s.decode[1]!(); expect(await second).toBeNull(); expect(s.cache.current).toBeNull(); expect(s.disposed).toContain('blob:atlas-1');
 s.cache.dispose(); expect(await s.cache.setDrawing(drawing())).toBeNull();
});
it('replaces rather than accumulating decoded pages', async () => {
 const s = setup(); let task = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!(); await task;
 task = s.cache.setDrawing(drawing(2)); await flush(); expect(s.disposed).toHaveLength(0); s.decode[1]!(); await task;
 expect(s.disposed).toEqual(['blob:atlas-0']); s.cache.dispose(); expect(s.disposed).toEqual(['blob:atlas-0', 'blob:atlas-1']);
});
it('admits candidates only in explicit review, with no caller image path', async () => {
 const s = setup(bundle('atlas.png', true)), review = new SceneCharacterMaskCache('review', () => {}, s.environment);
 const task = review.setDrawing(drawing()); await flush(); s.decode[0]!(); expect(await task).not.toBeNull(); expect(s.requests[0]).toBe('/companion-review-director/bundle.json'); review.dispose();
});
it('uses exact atlas alpha crop and viewport registration, not a body approximation', async () => {
 const s = setup(), task = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!(); const ready = (await task)!;
 const svg = inverseCharacterMaskSvg('body-mask', ready, { x: 50, y: 25, width: 200, height: 200 }, { x: 0, y: -15, width: 300, height: 285 });
 expect(svg).toContain('x="100" y="75" width="100" height="100" viewBox="1 2 2 2"'); expect(svg).toContain('0 0 0 1 0'); expect(svg).toContain('mask-type:luminance'); expect(svg).toContain('fill="white"'); expect(svg).toContain('href="blob:atlas-0"');
 expect(() => inverseCharacterMaskSvg('bad"id', ready, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 })).toThrow(); s.cache.dispose();
});

it('returning to the current atlas cancels a pending other page without disposing the displayed mask', async () => {
 const s = setup(); const first = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!(); await first;
 const pending = s.cache.setDrawing(drawing(2)); await flush(); const restored = await s.cache.setDrawing(drawing(0)); expect(restored?.atlasHref).toBe('blob:atlas-0');
 s.decode[1]!(); expect(await pending).toBeNull(); expect(s.cache.current).toBe(restored); expect(s.disposed).toEqual(['blob:atlas-1']); s.cache.dispose();
});

it('rasterizes exact inverse alpha including translucent edges and untouched outside pixels', async () => {
 const { default: sharp } = await import('sharp');
 const pixels = Buffer.alloc(8 * 8 * 4);
 for (const [x, y, alpha] of [[1, 2, 255], [2, 2, 128], [1, 3, 0], [2, 3, 64]]) {
  const offset = (y! * 8 + x!) * 4; pixels[offset] = 20; pixels[offset + 1] = 100; pixels[offset + 2] = 200; pixels[offset + 3] = alpha!;
 }
 const png = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
 const source: SceneCharacterMask = { key: 'test', atlasHref: `data:image/png;base64,${png.toString('base64')}`, atlasWidth: 8, atlasHeight: 8, canvas: [4, 4], rect: [1, 2, 2, 2], offset: [1, 1] };
 const defs = inverseCharacterMaskSvg('exact-alpha', source, { x: 0, y: 0, width: 4, height: 4 }, { x: 0, y: 0, width: 4, height: 4 });
 const out = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><defs>${defs}</defs><rect width="4" height="4" fill="red" mask="url(#exact-alpha)"/></svg>`)).ensureAlpha().raw().toBuffer();
 const alpha = (x: number, y: number) => out[(y * 4 + x) * 4 + 3]!;
 expect(alpha(0, 0)).toBe(255); expect(alpha(1, 1)).toBe(0); expect(Math.abs(alpha(2, 1) - 127)).toBeLessThanOrEqual(1);
 expect(alpha(1, 2)).toBe(255); expect(Math.abs(alpha(2, 2) - 191)).toBeLessThanOrEqual(1); expect(alpha(3, 3)).toBe(255);
});

it('prepares only the next same-package page without changing current alpha, then commits warm drawing synchronously', async () => {
 const value = bundle(); value.packages[0]!.frames[1]!.page = 1;
 const s = setup(value), first = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!(); const original = await first;
 await flush(); expect(s.decode).toHaveLength(2); expect(s.cache.current).toBe(original); expect(s.disposed).toEqual([]);
 s.decode[1]!(); await flush(); expect(s.cache.current).toBe(original); expect(s.updates.filter(Boolean)).toHaveLength(1); expect(s.disposed).toEqual([]);
 const updateCount = s.updates.length, next = s.cache.setDrawing(drawing(1));
 expect(s.cache.current?.key).toBe(JSON.stringify([epoch, 'selected', 1]));
 expect(s.updates.slice(updateCount).every(Boolean)).toBe(true);
 expect((await next)?.atlasHref).toBe('blob:atlas-1'); expect(s.disposed).toEqual(['blob:atlas-0']);
 expect(s.decode).toHaveLength(2); s.cache.dispose(); expect(s.disposed).toEqual(['blob:atlas-0', 'blob:atlas-1']);
});
it('keeps at most current plus next decoded pages and discards a prepared prediction on scope change', async () => {
 const value = bundle(); value.packages[0]!.pages.push({ file: 'atlas-002.png' });
 value.packages[0]!.frames[1]!.page = 1; value.packages[0]!.frames[2]!.page = 2;
 const s = setup(value), first = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!(); await first;
 await flush(); s.decode[1]!(); await flush(); expect(s.decode.length - s.disposed.length).toBe(2);
 await s.cache.setDrawing(drawing(1)); await flush(); expect(s.disposed).toEqual(['blob:atlas-0']);
 s.decode[2]!(); await flush(); expect(s.decode.length - s.disposed.length).toBe(2);
 expect(await s.cache.setDrawing(drawing(2, otherEpoch))).toBeNull();
 expect(s.disposed).toEqual(['blob:atlas-0', 'blob:atlas-2', 'blob:atlas-1']); expect(s.cache.current).toBeNull();
});
it('a hidden surface cancels speculative decode and never publishes its late completion', async () => {
 const value = bundle(); value.packages[0]!.frames[1]!.page = 1;
 const s = setup(value), first = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!(); await first;
 await flush(); s.cache.clear(); const updates = s.updates.length; s.decode[1]!(); await flush();
 expect(s.cache.current).toBeNull(); expect(s.updates).toHaveLength(updates); expect(s.disposed).toEqual(['blob:atlas-0', 'blob:atlas-1']);
});
it('reads the bundle-bound alpha page instead of the colour atlas, and falls back on any mismatch', async () => {
 const manifest = (bundleSHA256 = epoch) => ({ version: 1, bundleSHA256, pages: { 'atlas-000.png': { file: 'occlusion-atlas-000.png', sha256: 'c'.repeat(64), size: [8, 8] } } });
 const s = setup(bundle(), manifest()), first = s.cache.setDrawing(drawing()); await flush(); s.decode[0]!();
 expect((await first)?.rect).toEqual([1, 2, 2, 2]);
 expect(s.requests.filter(x => x.includes('.png'))[0]).toBe(`/companion-assets/occlusion-atlas-000.png?epoch=${epoch}`);
 expect(s.requests.some(x => x.startsWith('/companion-assets/atlas-000.png'))).toBe(false);
 for (const fallback of [setup(bundle(), manifest(otherEpoch)), setup(bundle(), manifest(), () => epoch), setup(bundle())]) {
  const pending = fallback.cache.setDrawing(drawing()); await flush(); fallback.decode[0]!();
  expect((await pending)?.rect).toEqual([1, 2, 2, 2]);
  expect(fallback.requests.filter(x => x.includes('.png')).at(-1)).toBe(`/companion-assets/atlas-000.png?epoch=${epoch}`);
 }
});
