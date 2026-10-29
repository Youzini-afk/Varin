import { readCompanionPackage, type CompanionPackage } from './sequencePackage';

/** Authenticated by the native caller's selected/review resource admission, not an arbitrary URL. */
export type SceneCharacterBundle = 'selected' | 'review';
export interface SceneCharacterDrawing { epoch: string; packageId: string; frameIndex: number }
export interface SceneCharacterMask {
  key: string; atlasHref: string; atlasWidth: number; atlasHeight: number;
  canvas: readonly [number, number]; rect: readonly [number, number, number, number]; offset: readonly [number, number];
}
interface DecodedAtlas { href: string; width: number; height: number; dispose(): void }
/** Dependency boundary permits deterministic deferred-decode tests; production uses only browser primitives. */
export interface SceneCharacterMaskEnvironment {
  fetch(input: string, signal: AbortSignal): Promise<Response>;
  sha256(bytes: ArrayBuffer): Promise<string>;
  decode(bytes: Blob, signal: AbortSignal): Promise<DecodedAtlas>;
}
const browserEnvironment: SceneCharacterMaskEnvironment = {
  fetch: (input, signal) => fetch(input, { signal, cache: 'no-store' }),
  sha256: async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''),
  async decode(bytes, signal) {
    const href = URL.createObjectURL(bytes), image = new Image();
    const dispose = () => { image.removeAttribute('src'); URL.revokeObjectURL(href); };
    const abort = () => dispose(); signal.addEventListener('abort', abort, { once: true });
    try {
      image.src = href; await image.decode();
      if (signal.aborted || !image.naturalWidth || !image.naturalHeight) throw new Error('Character mask decode cancelled or empty');
      const width = image.naturalWidth, height = image.naturalHeight;
      return { href, width, height, dispose };
    } catch (error) { dispose(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  },
};
const paths: Record<SceneCharacterBundle, string> = { selected: '/companion-assets/', review: '/companion-review-director/' };
const validEpoch = (value: string) => /^[a-f0-9]{64}$/.test(value);
const validPage = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/.test(value) && !value.includes('..');
interface PageJob { key: string; abort: AbortController; promise: Promise<DecodedAtlas> }

/** At most one decoded current atlas and one pending atlas. No node-wide preloading or PNG re-encoding. */
export class SceneCharacterMaskCache {
  private generation = 0;
  private request = 0;
  private epoch: string | null = null;
  private index: Promise<Map<string, CompanionPackage>> | null = null;
  private indexAbort: AbortController | null = null;
  private page: { key: string; atlas: DecodedAtlas } | null = null;
  private pending: PageJob | null = null;
  private ready: SceneCharacterMask | null = null;
  private disposed = false;
  constructor(private readonly selector: SceneCharacterBundle, private readonly changed: (mask: SceneCharacterMask | null) => void, private readonly environment = browserEnvironment) {
    if (!Object.hasOwn(paths, selector)) throw new Error('Unknown companion mask resource selector');
  }
  get current(): SceneCharacterMask | null { return this.ready; }
  private publish(value: SceneCharacterMask | null): void { if (this.ready === value) return; this.ready = value; this.changed(value); }
  private cancelPending(): void { this.pending?.abort.abort(); this.pending = null; }
  /** Scope/drag/hide must call clear synchronously, so no old-mask frame can be rendered. */
  clear(): void {
    this.generation++; this.request++; this.publish(null); this.cancelPending();
    this.indexAbort?.abort(); this.indexAbort = null; this.index = null; this.epoch = null;
    this.page?.atlas.dispose(); this.page = null;
  }
  dispose(): void { this.clear(); this.disposed = true; }
  private loadIndex(epoch: string): Promise<Map<string, CompanionPackage>> {
    this.indexAbort = new AbortController(); const signal = this.indexAbort.signal;
    return (async () => {
      const response = await this.environment.fetch(`${paths[this.selector]}bundle.json`, signal);
      if (!response.ok) throw new Error('Character mask bundle unavailable');
      const bytes = await response.arrayBuffer();
      if (await this.environment.sha256(bytes) !== epoch || signal.aborted) throw new Error('Character mask bundle epoch mismatch');
      const bundle = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(bundle.packages) || (this.selector === 'selected' && bundle.candidateOnly === true)) throw new Error('Unselected character mask bundle');
      const index = new Map<string, CompanionPackage>();
      for (const raw of bundle.packages) {
        const asset = readCompanionPackage(raw, this.selector === 'review');
        if (index.has(asset.id) || !asset.pages.every(page => validPage(page.file))) throw new Error('Invalid character mask resource index');
        index.set(asset.id, asset);
      }
      return index;
    })();
  }
  async setDrawing(drawing: SceneCharacterDrawing): Promise<SceneCharacterMask | null> {
    if (this.disposed) return null;
    if (!validEpoch(drawing.epoch) || typeof drawing.packageId !== 'string' || !drawing.packageId || !Number.isSafeInteger(drawing.frameIndex) || drawing.frameIndex < 0) { this.clear(); return null; }
    const key = JSON.stringify([drawing.epoch, drawing.packageId, drawing.frameIndex]);
    if (this.ready?.key === key) return this.ready;
    this.publish(null); // Never retain the previous exposure's silhouette while a new one loads.
    if (this.epoch !== drawing.epoch) { this.clear(); this.epoch = drawing.epoch; this.index = this.loadIndex(drawing.epoch); }
    const generation = this.generation, request = ++this.request;
    const latest = () => !this.disposed && generation === this.generation && request === this.request;
    try {
      const index = await this.index!;
      if (!latest()) return null;
      const asset = index.get(drawing.packageId), frame = asset?.frames[drawing.frameIndex];
      if (!asset || !frame) throw new Error('Character mask drawing is not in its bundle');
      const file = asset.pages[frame.page]!.file, pageKey = `${drawing.epoch}:${file}`;
      let atlas = this.page?.key === pageKey ? this.page.atlas : null;
      if (atlas && this.pending?.key !== pageKey) this.cancelPending();
      if (!atlas) {
        if (this.pending?.key !== pageKey) {
          this.cancelPending();
          const abort = new AbortController();
          const job: PageJob = { key: pageKey, abort, promise: Promise.resolve(null as unknown as DecodedAtlas) };
          job.promise = (async () => {
            const response = await this.environment.fetch(`${paths[this.selector]}${file}?epoch=${drawing.epoch}`, abort.signal);
            if (!response.ok) throw new Error('Character mask atlas unavailable');
            const decoded = await this.environment.decode(await response.blob(), abort.signal);
            if (abort.signal.aborted || this.pending !== job || generation !== this.generation) { decoded.dispose(); throw new Error('Superseded character mask atlas'); }
            this.page?.atlas.dispose(); this.page = { key: pageKey, atlas: decoded };
            return decoded;
          })();
          this.pending = job;
        }
        const job = this.pending!;
        try { atlas = await job.promise; }
        finally { if (this.pending === job) this.pending = null; }
        if (!latest()) return null;
      }
      if (frame.rect[0] + frame.rect[2] > atlas.width || frame.rect[1] + frame.rect[3] > atlas.height) throw new Error('Character mask frame escapes decoded atlas');
      const mask: SceneCharacterMask = { key, atlasHref: atlas.href, atlasWidth: atlas.width, atlasHeight: atlas.height, canvas: [...asset.canvas], rect: [...frame.rect], offset: [...frame.offset] };
      this.publish(mask); return mask;
    } catch {
      if (latest()) this.clear();
      return null;
    }
  }
}

export interface CharacterMaskRect { x: number; y: number; width: number; height: number }
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Pure SVG defs: white background minus the exact alpha from the registered, cropped source image. */
export function inverseCharacterMaskSvg(id: string, source: SceneCharacterMask, character: CharacterMaskRect, bounds: CharacterMaskRect): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ![...Object.values(character), ...Object.values(bounds)].every(Number.isFinite) || character.width <= 0 || character.height <= 0 || bounds.width <= 0 || bounds.height <= 0) throw new Error('Invalid character mask geometry');
  const [rx, ry, rw, rh] = source.rect, sx = character.width / source.canvas[0], sy = character.height / source.canvas[1];
  const x = character.x + source.offset[0] * sx, y = character.y + source.offset[1] * sy;
  return `<filter id="${id}-black" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter><mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" style="mask-type:luminance"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="white"/><svg x="${x}" y="${y}" width="${rw * sx}" height="${rh * sy}" viewBox="${rx} ${ry} ${rw} ${rh}" overflow="hidden" preserveAspectRatio="none"><image href="${escape(source.atlasHref)}" width="${source.atlasWidth}" height="${source.atlasHeight}" filter="url(#${id}-black)"/></svg></mask>`;
}
