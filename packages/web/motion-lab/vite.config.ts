import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Motion lab: real conversation components on simulated streams, for tuning
// and headless checks of motion. Development only; never part of a build.
const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');

export default defineConfig({
  root: here,
  plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } })],
  resolve: {
    alias: [
      { find: /^@varin\/application-client$/, replacement: path.resolve(web, '../application-client/src/index.ts') },
      { find: '@varin/application-client/settings-locales', replacement: path.resolve(web, '../application-client/src/settings-locales') },
      { find: '@varin/extension-contract', replacement: path.resolve(web, '../extension-contract/src/index.ts') },
      { find: '@varin/extension-loader', replacement: path.resolve(web, '../extension-loader/src/index.ts') },
      { find: '@varin/extension-sdk', replacement: path.resolve(web, '../extension-sdk/src/index.ts') },
      { find: '@varin/extension-surface', replacement: path.resolve(web, '../extension-surface/src/index.ts') },
      { find: '@varin/ui', replacement: path.resolve(web, '../ui/src') },
      { find: '@', replacement: path.resolve(web, '../ui/src') },
    ],
  },
  css: { postcss: web },
  worker: { format: 'es' },
  define: {
    'process.env': {},
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify('motion-lab'),
  },
  server: { port: 5199, strictPort: true },
});
