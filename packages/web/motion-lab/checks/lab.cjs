// Shared launcher for motion lab checks.
// PLAYWRIGHT_PATH: a playwright module directory (defaults to `playwright`).
// LAB_BROWSER: a Chromium-family executable (defaults to the bundled browser).
// LAB_URL: the running lab (defaults to http://localhost:5199/).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

// `query` opens another scene (`?scene=send`); `ready` is a page predicate for it.
const timelineReady = () => window.__lab && document.querySelector('[data-conversation-timeline-end-space]');

exports.openLab = async ({ width = 1280, height = 820, reducedMotion = 'no-preference', query = '', ready = timelineReady, hasTouch = false } = {}) => {
  const browser = await chromium.launch({ executablePath: process.env.LAB_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion, hasTouch });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  // Failed requests are judged by URL below; the console line carries none.
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  page.on('response', (response) => {
    // The lab has no Host: the composer's auth and settings probes are expected to miss.
    const { pathname } = new URL(response.url());
    if (response.status() >= 400 && !/^\/(auth|api)\//.test(pathname)) errors.push(`HTTP ${response.status()} ${pathname}`);
  });
  const url = `${process.env.LAB_URL || 'http://localhost:5199/'}${query}`;
  await page.goto(url);
  // Vite re-optimises dependencies the first time a scene pulls new ones in.
  await page.waitForTimeout(300);
  if (errors.some(error => error.includes('HTTP 504'))) {
    errors.length = 0;
    await page.goto(url);
  }
  try {
    await page.waitForFunction(ready, null, { timeout: 30000 });
  } catch (error) {
    console.error(errors.join('\n'));
    await browser.close();
    throw error;
  }
  await page.waitForTimeout(400);
  return { browser, page, errors };
};

exports.assert = (condition, message, failures) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};
