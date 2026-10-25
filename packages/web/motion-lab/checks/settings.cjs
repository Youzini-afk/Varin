// Settings window (§3.10): the navigation groups arrive on open; changing
// page slides one selection pill, swaps the breadcrumb the way the navigation
// moved, lets the old page leave quickly and brings the new page's header and
// sections in one after another.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__settings && document.querySelector('[data-settings-nav-pill] [aria-current="page"]');
const between = (values, from, to) => values.filter(value => value > Math.min(from, to) + 1 && value < Math.max(from, to) - 1).length;

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 1100, height: 760, query: '?scene=settings', ready });
  await page.waitForTimeout(600);
  const go = async (slug, ms = 800) => {
    await page.evaluate(() => window.__settings.record());
    await page.evaluate(next => window.__settings.open(next), slug);
    await page.waitForTimeout(ms);
    return page.evaluate(() => window.__settings.stopRecording());
  };

  for (const [slug, direction] of [['notifications', 1], ['appearance', -1]]) {
    const frames = await go(slug);
    const tops = frames.filter(sample => sample.pill).map(sample => sample.pill.top);
    const target = frames.at(-1).current.top;
    if (verbose) console.log(slug, 'pill:', tops.map(Math.round).join(' '));
    assert(between(tops, tops[0], target) >= 4 && Math.abs(tops.at(-1) - target) < 1, `${slug}: the pill slides ${Math.round(target - tops[0])}px to the page`, failures);
    const leaving = frames.filter(sample => sample.leaving);
    const ys = leaving.map(sample => sample.leaving.y);
    if (verbose) console.log(slug, 'leaving:', leaving.map(sample => `${sample.leaving.opacity.toFixed(2)}@${sample.leaving.y.toFixed(1)}`).join(' '));
    assert(leaving.length >= 1 && leaving.length <= 8 && ys.some(y => Math.sign(y) === -direction), `${slug}: the old page leaves ${direction > 0 ? 'upward' : 'downward'} in ${leaving.length} frames`, failures);
    const crumb = frames.filter(sample => sample.crumb.leaving !== null);
    const crumbMove = crumb.length > 1 ? crumb.at(-1).crumb.leaving - crumb[0].crumb.leaving : 0;
    assert(Math.sign(crumbMove) === -direction, `${slug}: the breadcrumb's old title leaves ${direction > 0 ? 'upward' : 'downward'} (${crumbMove.toFixed(1)}px)`, failures);
    const staggered = frames.some(sample => sample.parts.length > 1 && sample.parts[0] > sample.parts.at(-1) + 0.1);
    if (verbose) console.log(slug, 'parts:', frames.slice(0, 14).map(sample => sample.parts.map(value => value.toFixed(1)).join('/')).join(' '));
    assert(staggered && frames.at(-1).parts.every(value => value > 0.98), `${slug}: the header and sections arrive one after another`, failures);
  }

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
