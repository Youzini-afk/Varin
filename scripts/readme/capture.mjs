// Render README scenes with the shared product components, without a Host or user data.
// node scripts/readme/capture.mjs [--browser /path/to/chromium]
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { responses } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const webRequire = createRequire(path.join(root, 'packages/web/package.json'));
const electronRequire = createRequire(path.join(root, 'packages/electron/package.json'));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const { default: tailwind } = await import(pathToFileURL(webRequire.resolve('@tailwindcss/postcss')).href);
const { default: puppeteer } = await import(pathToFileURL(electronRequire.resolve('puppeteer-core')).href);
const { WebSocketServer } = webRequire('ws');
const arg = process.argv.indexOf('--browser');
const browserPath = arg >= 0 ? process.argv[arg + 1] : process.env.README_BROWSER || [
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(p => p && existsSync(p));
if (!browserPath) throw new Error('Set README_BROWSER or pass --browser with a Chromium executable.');
const sceneRoot = path.join(root, 'scripts/readme');
const server = await createServer({ configFile: false, root: sceneRoot, publicDir: path.join(root, 'packages/web/public'),
  cacheDir: path.join(sceneRoot, 'node_modules/.vite'),
  plugins: [react(), { name: 'readme-fixtures', configureServer(server) {
    const observations = new WebSocketServer({ noServer: true });
    server.httpServer.on('upgrade', (request, socket, head) => {
      if (new URL(request.url, 'http://localhost').pathname !== '/api/varin/observations/ws') return;
      observations.handleUpgrade(request, socket, head, connection => {
        connection.on('message', data => {
          const message = JSON.parse(String(data));
          if (message.type === 'open') connection.send(JSON.stringify({ type: 'headers', id: message.id,
            status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' } }));
          // No observations are emitted by these fixed source records.
        });
      });
    });
    server.httpServer.on('close', () => observations.close());
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/auth/url-token') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ token: 'readme-local', expiresAt: Date.now() + 3600000 })); return;
      }
      if (!pathname.startsWith('/api/')) return next();
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = Object.hasOwn(responses, pathname) ? 200 : 404;
      response.end(JSON.stringify(responses[pathname] ?? { message: `No README data for ${pathname}` }));
    });
  } }], css: { postcss: { plugins: [tailwind({ base: sceneRoot })] } },
  optimizeDeps: { entries: ['index.html'] },
  resolve: { alias: [
    { find: '@', replacement: path.join(root, 'packages/ui/src') },
    { find: '@varin/application-client', replacement: path.join(root, 'packages/application-client/src') },
    ...['react', 'react-dom', 'monaco-editor'].map(name => ({ find: name, replacement: path.join(root, 'packages/ui/node_modules', name) })),
  ] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--disable-extensions'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewport({ width: 1480, height: 940, deviceScaleFactor: 1.5 });
  const { port } = server.httpServer.address();
  const assets = path.join(root, '.github/readme/assets');
  for (const lang of ['en', 'zh-CN']) for (const scene of ['varin', 'workbench', 'ide', 'conversation', 'conversation-chart', 'conversation-choices', 'conversation-reading']) {
    if (process.env.README_SCENE && !process.env.README_SCENE.split(',').includes(scene)) continue;
    if (process.env.README_LANG && lang !== process.env.README_LANG) continue;
    console.log(`Rendering ${scene} (${lang})`);
    pageErrors.length = 0;
    await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&lang=${lang}`, { waitUntil: scene === 'conversation' || scene === 'conversation-chart' ? 'networkidle2' : 'networkidle0' });
    await page.waitForSelector('[data-readme-ready]');
    await page.waitForSelector('[data-conversation-composer-input-frame] .cm-content');
    await page.waitForFunction(() => !document.querySelector('[data-conversation-composer-input-frame] button[aria-busy="true"]'));
    if (scene === 'ide') await page.waitForSelector('[data-editor-ready]');
    await page.evaluate(() => document.fonts.ready);
    if (scene === 'varin') await (await page.$('input[type="radio"], [role="radio"]'))?.click();
    if (scene === 'conversation-choices') {
      const choices = await page.$$('input[type="checkbox"]');
      await choices[0].click(); await choices[1].click();
      await page.click('.question-field-title');
    }
    if (scene === 'conversation') {
      const frame = await (await page.waitForSelector('iframe')).contentFrame();
      await frame.waitForSelector('[data-estimate-ready]');
      await frame.$eval('#share', input => { input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await frame.waitForFunction(() => document.getElementById('saved').textContent === '15');
      await frame.$eval('#share', input => { input.value = '60'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
    }
    if (scene === 'conversation-chart') {
      const frame = await (await page.waitForSelector('iframe')).contentFrame();
      await frame.waitForSelector('[data-chart-ready]');
      await frame.select('#audience', 'new');
      await frame.waitForFunction(() => document.getElementById('value-0').textContent === '44%');
      await frame.select('#audience', 'all');
      await frame.waitForFunction(() => document.getElementById('value-0').textContent === '38%');
    }
    if (scene === 'conversation-reading') await page.waitForFunction(() => document.querySelectorAll('[data-image-state="loaded"]').length === 2);
    await page.mouse.move(20, 8);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (pageErrors.length) throw new Error(pageErrors.join('\n'));
    await page.screenshot({ path: path.join(assets, `${scene}-${lang}.png`) });
    console.log(`Captured ${scene}-${lang}.png`);
  }
} finally { await browser?.close(); await server.close(); }
