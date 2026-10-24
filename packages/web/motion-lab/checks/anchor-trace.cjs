// Traces a sent turn: anchoring, the reply growing beneath it, and the follow
// that starts past the comfortable line. LAB_MOTION=reduced compares levels.
const { openLab } = require('./lab.cjs');

(async () => {
  const { browser, page, errors } = await openLab();
  if (process.env.LAB_MOTION) await page.evaluate((level) => window.__lab.setMotion(level), process.env.LAB_MOTION);
  // LAB_PRESTREAM: send right as a previous reply finishes, as people do.
  if (process.env.LAB_PRESTREAM) await page.evaluate(() => window.__lab.stream({ chars: 600, cps: 160, interval: 48 }));
  const turnId = await page.evaluate(() => window.__lab.send());
  await page.evaluate((id) => window.__lab.record(id), turnId);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__lab.stream({ chars: 1800, cps: 160, interval: 48, burstEvery: 30, burst: 300 }));
  await page.waitForTimeout(800);
  const frames = await page.evaluate(() => window.__lab.stopRecording());
  let previous = null;
  for (const frame of frames) {
    const step = previous ? frame.scrollTop - previous.scrollTop : 0;
    if (!previous || Math.abs(step) > 0.25 || frame.turnTop !== previous.turnTop) {
      console.log(`${frame.t.toFixed(0).padStart(6)} top=${frame.scrollTop.toFixed(1).padStart(7)} step=${step.toFixed(1).padStart(6)} turn=${frame.turnTop === null ? '-' : frame.turnTop.toFixed(1)} gap=${frame.endGap.toFixed(0)} ${frame.mode}`);
    }
    previous = frame;
  }
  console.log(errors.filter((error) => !error.includes('404')));
  await browser.close();
})();
