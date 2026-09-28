import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const pwaDevEnabled = process.env.VARIN_DISABLE_PWA_DEV !== '1';
const lowMemoryBuild = process.env.VARIN_LOW_MEMORY_BUILD === '1';
const monacoSmokeEnabled = process.env.VARIN_MONACO_SMOKE === '1';
const monacoBundleAuditEnabled = process.env.VARIN_MONACO_BUNDLE_AUDIT === '1';
const reactScanToggle = (process.env.VITE_ENABLE_REACT_SCAN ?? '').toLowerCase();
const enableReactScan = reactScanToggle === '1' || reactScanToggle === 'true' || reactScanToggle === 'on' || reactScanToggle === 'yes';
const themeDirectory = path.resolve(__dirname, '../ui/src/lib/theme/themes');

const packageNameFromModuleId = (id: string): string | null => {
  const normalized = id.replace(/\\/g, '/');
  const match = normalized.split('node_modules/').at(-1);
  if (!match) return null;
  const segments = match.split('/');
  return match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0] || null;
};

const themeJsonHmrPlugin = () => ({
  name: 'varin-theme-json-hmr',
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (payload: unknown) => void } } }) {
    if (!file.startsWith(`${themeDirectory}${path.sep}`) || path.extname(file) !== '.json') {
      return;
    }

    try {
      server.ws.send({
        type: 'custom',
        event: 'varin:theme-updated',
        data: JSON.parse(readFileSync(file, 'utf-8')),
      });
      // Theme JSON is applied by the runtime event listener. Returning no
      // modules prevents Vite's otherwise unavoidable page-reload fallback.
      return [];
    } catch {
      // Leave the previous valid theme active while an editor writes invalid
      // or incomplete JSON; the next valid save will replace it.
      return [];
    }
  },
});

export default defineConfig({
  root: path.resolve(__dirname, '.'),
  plugins: [
    react({
      babel: {
        plugins: lowMemoryBuild ? [] : ['babel-plugin-react-compiler'],
      },
    }),
    {
      name: 'inject-react-scan-script',
      transformIndexHtml() {
        if (!enableReactScan) {
          return;
        }
        return [
          {
            tag: 'script',
            attrs: {
              crossorigin: 'anonymous',
              src: '//unpkg.com/react-scan/dist/auto.global.js',
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
    themeJsonHmrPlugin(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,otf,eot}'],
        // iOS Safari/PWA is much more reliable with a classic (non-module) SW bundle.
        rollupFormat: 'iife',
        // We already keep a custom manifest in index.html
        injectionPoint: undefined,
      },
      devOptions: {
        enabled: pwaDevEnabled,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@varin/application-client', replacement: path.resolve(__dirname, '../application-client/src/index.ts') },
      { find: '@varin/extension-contract', replacement: path.resolve(__dirname, '../extension-contract/src/index.ts') },
      { find: '@varin/extension-loader', replacement: path.resolve(__dirname, '../extension-loader/src/index.ts') },
      { find: '@varin/extension-sdk', replacement: path.resolve(__dirname, '../extension-sdk/src/index.ts') },
      { find: '@varin/extension-surface', replacement: path.resolve(__dirname, '../extension-surface/src/index.ts') },
      { find: '@varin/ui', replacement: path.resolve(__dirname, '../ui/src') },
      { find: '@web', replacement: path.resolve(__dirname, './src') },
      { find: '@', replacement: path.resolve(__dirname, '../ui/src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/auth': {
        target: `http://127.0.0.1:${process.env.VARIN_PORT || 3001}`,
        changeOrigin: true,
      },
      '/health': {
        target: `http://127.0.0.1:${process.env.VARIN_PORT || 3001}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${process.env.VARIN_PORT || 3001}`,
        changeOrigin: true,
        rewriteWsOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: monacoBundleAuditEnabled,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      maxParallelFileOps: lowMemoryBuild ? 24 : 1000,
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobile: path.resolve(__dirname, 'mobile.html'),
        miniChat: path.resolve(__dirname, 'mini-chat.html'),
        ...(monacoSmokeEnabled ? { monacoSmoke: path.resolve(__dirname, 'monaco-smoke.html') } : {}),
      },
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        manualChunks(id) {
          // Keep Vite's tiny dynamic-import runtime independent. Without an
          // explicit chunk Rollup can place it inside a large registry package
          // (observed with Shiki), making every entry preload that package just
          // to call the helper.
          if (id.includes('vite/preload-helper')) return 'vite-preload-helper';
          if (!id.includes('node_modules')) return undefined;

          // Bun and pnpm place packages below an intermediate store directory
          // followed by another node_modules segment. Use the innermost package
          // path; otherwise every Bun dependency is misidentified as `.bun`
          // and collapsed into one enormous eagerly preloaded vendor chunk.
          const packageName = packageNameFromModuleId(id);
          if (!packageName) return undefined;

          // These packages expose registries of dynamically imported grammars,
          // themes and modes. Grouping each whole package defeats that design
          // and makes the first requested language download every sibling.
          if (
            packageName === '@shikijs/langs' ||
            packageName === '@shikijs/themes' ||
            packageName === '@codemirror/legacy-modes' ||
            packageName === '@pierre/diffs' ||
            // These are facade packages whose imports Rollup resolves into
            // sibling packages. Naming a manual chunk for the empty facade
            // emits useless zero-byte files and warnings.
            packageName === 'reselect' ||
            packageName === 'detect-node-es' ||
            packageName === 'motion'
          ) {
            return undefined;
          }

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand';

          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown';
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui';
          if (packageName.includes('react-syntax-highlighter') || packageName.includes('highlight.js')) return 'vendor-syntax';

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-');
          return `vendor-${sanitized}`;
        },
      },
    },
  },
});
