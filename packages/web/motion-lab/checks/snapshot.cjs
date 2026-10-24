// Screenshot the live edge mid-stream: `node snapshot.cjs <out-dir> [delayMs]`.
const path = require('node:path');
const { openLab } = require('./lab.cjs');

(async () => {
  const { browser, page } = await openLab({ width: 1100, height: 760 });
  const streaming = page.evaluate(() => window.__lab.stream({ chars: 1400, cps: 150, interval: 100, rich: true }));
  await page.waitForTimeout(Number(process.argv[3] || 2600));
  const out = path.resolve(process.argv[2] || '.', 'motion-lab-stream.png');
  await page.screenshot({ path: out });
  console.log(out);
  await streaming;
  await browser.close();
})();
