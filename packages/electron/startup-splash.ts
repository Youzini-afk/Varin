import { splashCubeMarkup } from '../ui/src/components/ui/varin-splash-cube.js';
import { splashGroundScript } from '../ui/src/components/ui/varin-splash-canvas.js';
import { splashPlaneCss, VARIN_SPLASH_COLORS } from '../ui/src/components/ui/varin-splash-lattice.js';

/** The desktop wait page holds the real loading scene at its first frame. */
export function createStartupSplashHtml(input: { dark: boolean; background?: string | undefined; foreground?: string | undefined }): string {
  const palette = JSON.stringify({
    '--splash-background': input.background || (input.dark ? '#151313' : '#FFFCF0'),
    '--splash-stroke': input.foreground || (input.dark ? '#CECDC3' : '#100F0F'),
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Varin</title>
  <script>Object.entries(${palette}).forEach(function(entry){document.documentElement.style.setProperty(entry[0],entry[1]);});</script>
  <style>
    :root {
      color-scheme: ${input.dark ? 'dark' : 'light'};
      --splash-face-fill: ${input.dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'};
      --splash-cell-fill: ${input.dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)'};
      --splash-lattice-line: ${input.dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)'};
      --splash-cell-pulse: var(--splash-background);
    }
    @supports (color: color-mix(in srgb, white 50%, transparent)) {
      :root {
        --splash-face-fill: color-mix(in srgb, var(--splash-stroke) 15%, transparent);
        --splash-cell-fill: color-mix(in srgb, var(--splash-stroke) 35%, transparent);
        --splash-lattice-line: color-mix(in srgb, var(--splash-stroke) 22%, transparent);
        --splash-cell-pulse: color-mix(in srgb, var(--splash-stroke) 7%, var(--splash-background));
      }
    }
    html, body { margin: 0; width: 100%; height: 100%; background: var(--splash-background); }
    ${splashPlaneCss(VARIN_SPLASH_COLORS, { withMark: true })}
    .varin-splash *, .varin-splash *::before, .varin-splash *::after { animation-play-state: paused !important; }
  </style>
</head>
<body>
  <div class="varin-splash" data-leaving="false" role="status" aria-label="Loading Varin">
    <div class="varin-splash-backdrop" aria-hidden="true"></div>
    <div class="varin-splash-ground-clip" aria-hidden="true">
      <div class="varin-splash-horizon">
        <div class="varin-splash-camera">
          <div id="desktop-startup-ground" class="varin-splash-ground"></div>
          <span class="varin-splash-mark">${splashCubeMarkup()}</span>
        </div>
      </div>
    </div>
  </div>
  <script>${splashGroundScript('desktop-startup-ground', VARIN_SPLASH_COLORS, { breathe: false })}</script>
</body>
</html>`;
}
