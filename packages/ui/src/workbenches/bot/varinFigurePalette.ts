import { fromLab, parseAccent, toLab, type RGB } from '@/components/companion/companionAccentPalette';
import type { Theme } from '@/types/theme';

/**
 * Theme colours for the Bot figure, following the desktop companion (docs/design/desktop-companion.md
 * §7): the accent parts take the resolved theme's real accent, `colors.primary.base`; the eyes, hair,
 * skin, white coat and black ribbon and straps stay. Varin's own themes keep the drawn mist blue.
 *
 * Each accent colour keeps its lightness, so the drawing's light and shade survive, and takes the
 * accent's hue at a chroma scaled by how saturated the accent is. Neutral accents give layered greys.
 */
export interface FigureAccent {
  /** Stable key for the palette; `default` for the drawn colours. */
  readonly key: string;
  /** Maps one of the figure's accent colours (#rrggbb) to the theme's version. */
  readonly tint: (hex: string) => string;
}

const identity = (hex: string): string => hex;
export const DEFAULT_FIGURE_ACCENT: FigureAccent = Object.freeze({ key: 'default', tint: identity });

const toHex = (rgb: RGB): string => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const inGamut = (rgb: RGB): boolean => rgb.every(v => v >= -0.5 && v <= 255.5);

export function resolveFigureAccent(theme: Theme | null | undefined): FigureAccent {
  const accent = parseAccent(theme?.colors?.primary?.base);
  if (!accent) return DEFAULT_FIGURE_ACCENT;
  if ((theme?.metadata?.id === 'varin-dark' && accent.hex === '7aa7ef')
    || (theme?.metadata?.id === 'varin-light' && accent.hex === '4b6fac')) return DEFAULT_FIGURE_ACCENT;
  const [La, aa, ba] = toLab(accent.rgb), chroma = Math.hypot(aa, ba);
  const neutral = chroma < 0.005;
  // A small lightness bias separates pine from mint and brown from apricot, as for the companion.
  const shift = neutral ? (La - 0.5) * 0.08 : Math.max(-0.03, Math.min(0.03, (La - 0.65) * 0.08));
  const strength = neutral ? 0 : Math.min(1, Math.max(0.35, chroma / 0.12));
  const cache = new Map<string, string>();
  const tint = (hex: string): string => {
    const cached = cache.get(hex);
    if (cached) return cached;
    const source = parseAccent(hex);
    if (!source) return hex;
    const [L, a, b] = toLab(source.rgb), lightness = Math.min(0.97, Math.max(0.05, L + shift));
    let c = Math.hypot(a, b) * strength;
    let rgb = neutral ? fromLab(lightness, 0, 0) : fromLab(lightness, aa / chroma * c, ba / chroma * c);
    // Reduce chroma rather than clip channels when the accent's hue leaves the sRGB gamut.
    while (!neutral && !inGamut(rgb) && c > 0.0001) { c *= 0.9; rgb = fromLab(lightness, aa / chroma * c, ba / chroma * c); }
    const result = toHex(rgb);
    cache.set(hex, result);
    return result;
  };
  return { key: `accent-oklab-v1:${accent.hex}`, tint };
}
