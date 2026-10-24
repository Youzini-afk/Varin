// Loads the lab, reports page errors and writes a screenshot.
const path = require('node:path');
const { openLab } = require('./lab.cjs');

(async () => {
  const { browser, page, errors } = await openLab();
  const out = path.resolve(process.argv[2] || '.', 'motion-lab-smoke.png');
  await page.screenshot({ path: out });
  console.log(JSON.stringify({ errors, metrics: await page.evaluate(() => window.__lab.metrics()), screenshot: out }, null, 2));
  await browser.close();
})();
