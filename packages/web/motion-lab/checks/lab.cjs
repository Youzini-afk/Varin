// Shared launcher for motion lab checks.
// PLAYWRIGHT_PATH: a playwright module directory (defaults to `playwright`).
// LAB_BROWSER: a Chromium-family executable (defaults to the bundled browser).
// LAB_URL: the running lab (defaults to http://localhost:5199/).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

exports.openLab = async ({ width = 1280, height = 820, reducedMotion = 'no-preference' } = {}) => {
  const browser = await chromium.launch({ executablePath: process.env.LAB_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.LAB_URL || 'http://localhost:5199/');
  try {
    await page.waitForFunction(() => window.__lab && document.querySelector('[data-conversation-timeline-end-space]'), null, { timeout: 30000 });
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
