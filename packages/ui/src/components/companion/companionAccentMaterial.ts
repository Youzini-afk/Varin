import profile from './companionAccentProfile.json';
import type { CompanionPackage } from './sequencePackage';

export type AccentRect = readonly [number, number, number, number];
export interface AccentSourceRegions { allow: readonly AccentRect[]; protect: readonly AccentRect[] }
const regions: Record<string, AccentSourceRegions> = {};
for (const [sha256, source] of Object.entries(profile.sources)) {
  if (!validAccentSourceRegions(source)) throw new Error(`Invalid companion accent regions: ${sha256}`);
  regions[sha256] = source;
}
const inside = (x: number, y: number, r: AccentRect) => x >= r[0] && y >= r[1] && x < r[2] && y < r[3];
const smooth = (low: number, high: number, value: number) => { const t = Math.max(0, Math.min(1, (value - low) / (high - low))); return t * t * (3 - 2 * t); };
// Fixed material response, not per-frame histogram normalization. Original folds and
// knit highlights retain their tonal ordering; different source blues converge on one cloth.
const stops = [[64, 54, 62, 88], [196, 133, 144, 178], [232, 155, 165, 200], [255, 176, 187, 222]] as const;
function tone(value: number, channel: 1 | 2 | 3): number {
  if (value <= stops[0][0]) return stops[0][channel] * value / stops[0][0];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (value <= b[0]) return a[channel] + (b[channel] - a[channel]) * (value - a[0]) / (b[0] - a[0]);
  }
  return stops.at(-1)![channel];
}

export function validAccentSourceRegions(value: unknown): value is AccentSourceRegions {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<AccentSourceRegions>;
  if (!Array.isArray(source.allow) || !Array.isArray(source.protect)) return false;
  const valid = (r: unknown): r is AccentRect => Array.isArray(r) && r.length === 4 && r.every(Number.isSafeInteger)
    && r[0] >= 0 && r[1] >= 0 && r[2] <= 512 && r[3] <= 512 && r[0] < r[2] && r[1] < r[3];
  if (![...source.allow, ...source.protect].every(valid)) return false;
  return source.allow.every((a, i) => source.allow!.slice(i + 1).every(b => a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]));
}

/** Mutates only eligible accent RGB. Alpha and protected pixels are never assigned. */
export function applyCompanionAccentPixels(pixels: Uint8ClampedArray, width: number, height: number, source: AccentSourceRegions): number {
  if (width !== 512 || height !== 512 || pixels.length !== width * height * 4 || !validAccentSourceRegions(source)) throw new Error('Accent material requires registered RGBA canvas');
  let changed = 0;
  for (const area of source.allow) for (let y = area[1]; y < area[3]; y++) for (let x = area[0]; x < area[2]; x++) {
    if (source.protect.some(r => inside(x, y, r))) continue;
    const i = (y * width + x) * 4, r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
    if (pixels[i + 3]! < 240) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    // Near-black outlines/laptop edges are not cloth, even when numerically blue.
    if (max < 80 || !delta || max !== b) continue;
    const hue = 60 * (4 + (r - g) / delta), saturation = delta / max;
    const weight = smooth(190, 205, hue) * (1 - smooth(235, 250, hue)) * smooth(0.28, 0.45, saturation);
    if (!weight) continue;
    const next = [r, g, b].map((v, c) => Math.round(v + (tone(max, (c + 1) as 1 | 2 | 3) - v) * weight));
    if (next[0] === r && next[1] === g && next[2] === b) continue;
    pixels[i] = next[0]!; pixels[i + 1] = next[1]!; pixels[i + 2] = next[2]!; changed++;
  }
  return changed;
}

/** Two registered processed exposures (2 MiB); no atlas mutation or bitmap retention.
 * Bitmap identity invalidates cached pixels when a decoded generation is replaced. */
export class CompanionAccentMaterial {
  private cache = new Map<string, { bitmap: WeakRef<ImageBitmap>; pixels: ImageData }>();
  clear(): void { this.cache.clear(); }
  apply(stage: CanvasRenderingContext2D, sequence: CompanionPackage, bitmap: ImageBitmap, exposure: number, epoch: string | null): boolean {
    const frame = sequence.frames[exposure], source = frame?.sha256 && regions[frame.sha256];
    if (epoch !== profile.bundleSHA256 || sequence.geometryReference !== profile.geometryReference || !source) return false;
    const key = `${profile.id}:${frame.sha256}`;
    const hit = this.cache.get(key);
    if (hit?.bitmap.deref() === bitmap) {
      this.cache.delete(key); this.cache.set(key, hit); stage.putImageData(hit.pixels, 0, 0); return true;
    }
    const pixels = stage.getImageData(0, 0, sequence.canvas[0], sequence.canvas[1]);
    applyCompanionAccentPixels(pixels.data, pixels.width, pixels.height, source);
    stage.putImageData(pixels, 0, 0);
    this.cache.delete(key); this.cache.set(key, { bitmap: new WeakRef(bitmap), pixels });
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
    return true;
  }
}
