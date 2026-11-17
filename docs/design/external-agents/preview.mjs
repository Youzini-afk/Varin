import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(root, '../../..');
const output = path.join(repo, '.git/design-preview/external-agents');
const config = {
  configFile: false,
  root,
  base: './',
  publicDir: false,
  plugins: [react()],
  css: { postcss: { plugins: [tailwind()] } },
  resolve: { alias: [
    { find: /^@varin\/application-client$/, replacement: path.join(repo, 'packages/application-client/src/index.ts') },
    { find: /^@varin\/application-client\/(.*)$/, replacement: path.join(repo, 'packages/application-client/src/$1') },
    ...['react', 'react-dom', 'motion'].map(name => ({ find: name, replacement: path.join(repo, 'packages/ui/node_modules', name) })),
    { find: '@', replacement: path.join(repo, 'packages/ui/src') },
  ] },
  define: { 'process.env': {}, __APP_VERSION__: JSON.stringify('design-preview') },
};

if (process.argv.includes('--build')) {
  const result = await build({ ...config, build: {
    write: false, assetsInlineLimit: Infinity, cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const assets = (Array.isArray(result) ? result[0] : result).output;
  let html = String(assets.find(file => file.fileName === 'index.html').source);
  const js = assets.filter(file => file.type === 'chunk').map(file => file.code).join('\n');
  const css = assets.filter(file => file.fileName.endsWith('.css')).map(file => file.source).join('\n');
  html = html.replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '')
    .replace(/<link\b[^>]*\brel="(?:stylesheet|modulepreload)"[^>]*>/g, '')
    .replace('</head>', () => `<style>${css}</style></head>`)
    .replace('</body>', () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script></body>`);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'preview.html'), html);
  console.log(path.join(output, 'preview.html'));
} else {
  const server = await createServer({ ...config, server: {
    host: '127.0.0.1', port: 5189, strictPort: true,
    fs: { allow: [repo] },
  } });
  await server.listen();
  server.printUrls();
}
