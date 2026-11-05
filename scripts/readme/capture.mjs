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
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
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
  page.on('pageerror', error => console.error(error.message));
  await page.setViewport({ width: 1480, height: 940, deviceScaleFactor: 1.5 });
  const { port } = server.httpServer.address();
  const assets = path.join(root, '.github/readme/assets');
  for (const lang of ['en', 'zh-CN']) for (const scene of ['varin', 'workbench', 'ide', 'conversation', 'conversation-choices', 'conversation-reading']) {
    if (process.env.README_SCENE && !process.env.README_SCENE.split(',').includes(scene)) continue;
    if (process.env.README_LANG && lang !== process.env.README_LANG) continue;
    console.log(`Rendering ${scene} (${lang})`);
    await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&lang=${lang}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-readme-ready]');
    await page.waitForSelector('[data-conversation-composer-input-frame] .cm-content');
    await page.waitForFunction(() => !document.querySelector('[data-conversation-composer-input-frame] button[aria-busy="true"]'));
    if (scene === 'ide') await page.waitForSelector('[data-editor-ready]');
    await page.evaluate(() => document.fonts.ready);
    if (scene === 'varin') await (await page.$('input[type="radio"], [role="radio"]'))?.click();
    if (scene === 'conversation-choices') {
      const choices = await page.$$('input[type="checkbox"]');
      await choices[0].click(); await choices[1].click();
      await page.click('.question-supplement-toggle');
      await page.$eval('.question-supplement textarea', (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, lang === 'en' ? 'Keep the wording direct. Add the download link at the end.' : '语气直接一些，最后附上下载入口。');
      await page.$eval('input[type="range"]', input => { input.value = '400'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('.question-field-title');
    }
    if (scene === 'conversation-reading') await page.waitForFunction(() => document.querySelectorAll('[data-image-state="loaded"]').length === 2);
    await page.mouse.move(20, 8);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(assets, `${scene}-${lang}.png`) });
    console.log(`Captured ${scene}-${lang}.png`);
  }
} finally { await browser?.close(); await server.close(); }
