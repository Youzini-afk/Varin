import type { Theme } from '@/types/theme';

type RGB = readonly [number, number, number];
type ToneStop = readonly [number, number, number, number];
export interface CompanionAccentPalette {
  readonly signature: string;
  /** Interleaved floating-point RGB response for each source maximum, before mask blending. */
  readonly tones: readonly number[];
}

// The approved mist-blue response is deliberately not regenerated through a color space.
// Keep floating-point interpolation and the pixel blend's rounding exactly as approved.
const defaultStops: readonly ToneStop[] = [[64, 54, 62, 88], [196, 133, 144, 178], [232, 155, 165, 200], [255, 176, 187, 222]];
function palette(signature: string, stops: readonly ToneStop[]): CompanionAccentPalette {
  const tones: number[] = [];
  for (let value = 0; value < 256; value++) for (const channel of [1, 2, 3] as const) {
    if (value <= stops[0]![0]) { tones.push(stops[0]![channel] * value / stops[0]![0]); continue; }
    const end = stops.findIndex(stop => value <= stop[0]);
    const a = stops[end - 1]!, b = stops[end]!;
    tones.push(a[channel] + (b[channel] - a[channel]) * (value - a[0]) / (b[0] - a[0]));
  }
  return Object.freeze({ signature, tones: Object.freeze(tones) });
}
export const DEFAULT_COMPANION_ACCENT_PALETTE = palette('mist-blue-v1', defaultStops);

// The UI's CSS generator serializes RGB but has no perceptual conversion utility.
// OKLab is used only when resolving a palette, never in the per-pixel material loop.
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const encoded = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function toLab(rgb: RGB): RGB {
  const [r, g, b] = rgb.map(v => linear(v / 255));
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab(L: number, a: number, b: number): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [encoded(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encoded(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encoded(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
function parseAccent(value: unknown): { hex: string; rgb: RGB } | null {
  if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) return null;
  let hex = value.trim().slice(1).toLowerCase();
  if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
  return { hex, rgb: [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as unknown as RGB };
}

/** Accent authority is the resolved theme, not its name or an eight-skin lookup table.
 * Unsupported/transparent CSS colors safely retain the approved default material. */
export function resolveCompanionAccentPalette(theme: Theme | null | undefined): CompanionAccentPalette {
  const accent = parseAccent(theme?.colors?.primary?.base);
  if (!accent) return DEFAULT_COMPANION_ACCENT_PALETTE;
  if ((theme?.metadata?.id === 'varin-dark' && accent.hex === '7aa7ef')
    || (theme?.metadata?.id === 'varin-light' && accent.hex === '4b6fac')) return DEFAULT_COMPANION_ACCENT_PALETTE;
  const [L, a, b] = toLab(accent.rgb), chroma = Math.hypot(a, b);
  const neutral = chroma < 0.005;
  // Cloth luminance follows the original folds, not the UI's background mode.
  // A small accent-luminance bias distinguishes pine/mint and brown/apricot pairs.
  const shift = neutral ? (L - 0.5) * 0.08 : Math.max(-0.025, Math.min(0.025, (L - 0.65) * 0.06));
  const targetChroma = neutral ? 0 : Math.min(0.068, chroma * 0.48);
  const stops = defaultStops.map(([value, r, g, blue], i): ToneStop => {
    const lightness = toLab([r, g, blue])[0] + shift;
    let c = targetChroma * [0.7, 1, 1, 0.9][i]!;
    let rgb = fromLab(lightness, neutral ? 0 : a / chroma * c, neutral ? 0 : b / chroma * c);
    // Reduce chroma rather than clip channels if a future accent leaves sRGB gamut.
    while (rgb.some(v => v < 0 || v > 255) && c > 0.0001) {
      c *= 0.9; rgb = fromLab(lightness, a / chroma * c, b / chroma * c);
    }
    return [value, ...rgb];
  });
  return palette(`accent-oklab-v1:${accent.hex}`, stops);
}
