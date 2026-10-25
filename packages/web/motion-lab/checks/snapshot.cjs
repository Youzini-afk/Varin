// Screenshot mid-scenario: `node snapshot.cjs <out-dir> [delayMs] [stream|process] [name]`.
const path = require('node:path');
const { openLab } = require('./lab.cjs');

(async () => {
  const [outDir = '.', delay = '2600', scenario = 'stream', name = `motion-lab-${scenario}`] = process.argv.slice(2);
  const { browser, page } = await openLab({ width: 1100, height: 760 });
  const running = page.evaluate((kind) => kind === 'process' ? window.__lab.process()
    : kind === 'file' ? window.__lab.fileEdit({ pace: 3, pathLast: true })
      : kind === 'tray' ? window.__lab.tray()
      : window.__lab.stream({ chars: 1400, cps: 150, interval: 100, rich: true }), scenario);
  await page.waitForTimeout(Number(delay));
  const out = path.resolve(outDir, `${name}.png`);
  await page.screenshot({ path: out });
  console.log(out);
  await running;
  await browser.close();
})();
