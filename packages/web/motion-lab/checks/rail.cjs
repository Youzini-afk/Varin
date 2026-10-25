// Context rail (§3.10): one active bar slides between buttons on glide and
// follows a reorder, appears and leaves in place with the panel, the first
// Git count settles in and later ones change in place, and one tooltip slides
// along the rail instead of reopening.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__rail && document.querySelector('[data-rail-surface]');
const between = (values, from, to) => values.filter(value => value > Math.min(from, to) + 1 && value < Math.max(from, to) - 1).length;

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 900, height: 700, query: '?scene=rail', ready });
  const record = async (action, ms) => {
    await page.evaluate(() => window.__rail.record());
    await action();
    await page.waitForTimeout(ms);
    return page.evaluate(() => window.__rail.stopRecording());
  };

  // 1. Opening a panel shows the bar in place; switching slides it.
  const open = await record(() => page.evaluate(() => window.__rail.open('threads')), 400);
  const shown = open.filter(sample => sample.bar && sample.bar.opacity > 0.5);
  assert(shown.length > 0 && Math.abs(shown.at(-1).bar.top - (shown.at(-1).active.top + 8)) < 1.5, 'opening a panel puts the bar beside its button', failures);
  const tops = new Set(shown.map(sample => Math.round(sample.bar.top)));
  assert(tops.size === 1, `it appears in place rather than sliding in (${tops.size} positions)`, failures);
  const move = await record(() => page.evaluate(() => window.__rail.open('recovery')), 800);
  const bar = move.filter(sample => sample.bar).map(sample => sample.bar.top);
  const target = move.at(-1).active.top + 8;
  if (verbose) console.log('bar:', bar.map(Math.round).join(' '));
  assert(between(bar, bar[0], target) >= 4 && Math.abs(bar.at(-1) - target) < 1, `switching slides the bar ${Math.round(target - bar[0])}px through ${between(bar, bar[0], target)} frames`, failures);
  const close = await record(() => page.evaluate(() => window.__rail.close()), 400);
  assert(close.at(-1).bar.opacity < 0.05 && new Set(close.map(sample => Math.round(sample.bar.top))).size === 1, 'closing fades the bar out in place', failures);

  // The panel itself: it glides open while the main column changes width once.
  const panelOpen = await record(() => page.evaluate(() => window.__rail.open('context')), 900);
  const mains = [...new Set(panelOpen.map(sample => Math.round(sample.main)))];
  const panels = panelOpen.map(sample => sample.panel);
  if (verbose) console.log('open main:', mains.join(' '), '| panel:', panels.map(Math.round).join(' '));
  assert(between(panels, panels[0], panels.at(-1)) >= 5, `the panel glides open (${Math.round(panels[0])} → ${Math.round(panels.at(-1))}px)`, failures);
  assert(mains.length <= 2, `the main column takes ${mains.length - 1} width change while it opens (${mains.join(' → ')})`, failures);
  const panelClose = await record(() => page.evaluate(() => window.__rail.close()), 1100);
  const closingMains = [...new Set(panelClose.map(sample => Math.round(sample.main)))];
  if (verbose) console.log('close main:', closingMains.join(' '));
  assert(closingMains.length <= 2, `and ${closingMains.length - 1} while it closes (${closingMains.join(' → ')})`, failures);

  // The Git view tabs: one underline slides between them.
  const lineAt = () => page.evaluate(() => window.__rail.underline());
  const startLine = await lineAt();
  if (verbose) console.log('underline start:', JSON.stringify(startLine));
  assert(startLine && Math.abs(startLine.left - startLine.tab) < 1 && Math.abs(startLine.width - startLine.tabWidth) < 1, 'the underline sits under the pressed tab', failures);
  const lefts = await page.evaluate(() => new Promise((resolve) => {
    const values = [];
    window.__rail.gitTab('pr');
    const started = performance.now();
    const tick = () => { values.push(window.__rail.underline().left); if (performance.now() - started < 700) requestAnimationFrame(tick); else resolve(values); };
    requestAnimationFrame(tick);
  }));
  const endLine = await lineAt();
  if (verbose) console.log('underline:', lefts.map(Math.round).join(' '));
  assert(between(lefts, startLine.left, endLine.tab) >= 4 && Math.abs(endLine.left - endLine.tab) < 1, `it slides ${Math.round(endLine.tab - startLine.left)}px to the other tab`, failures);

  // 2. The Git count: the first one settles in, later ones change in place.
  const arrive = await record(() => page.evaluate(() => window.__rail.changes(3)), 700);
  const scales = arrive.filter(sample => sample.badge).map(sample => sample.badge.scale);
  if (verbose) console.log('badge:', scales.join(' '));
  assert(scales.length > 3 && scales[0] !== 'none' && scales.some(scale => Number(scale) > 1.001), `the first count settles in with a small overshoot (${scales.slice(0, 4).join(', ')}…)`, failures);
  const change = await record(() => page.evaluate(() => window.__rail.changes(4)), 400);
  assert(change.at(-1).badge.text === '4' && change.every(sample => sample.badge && (sample.badge.scale === 'none' || sample.badge.scale === '1')), 'a later count changes in place without arriving again', failures);

  // 3. One tooltip slides along the rail.
  const buttons = page.locator('[data-rail-surface]');
  await buttons.nth(0).hover();
  await page.waitForTimeout(450);
  const slide = await record(() => buttons.nth(2).hover(), 500);
  const tip = slide.filter(sample => sample.tooltip).map(sample => sample.tooltip.top);
  if (verbose) console.log('tooltip:', tip.map(Math.round).join(' '));
  assert(tip.length > 3 && slide.every(sample => sample.tooltip), 'the tooltip stays open while moving between buttons', failures);
  assert(between(tip, tip[0], tip.at(-1)) >= 2, `it slides ${Math.round(tip.at(-1) - tip[0])}px to the next button through ${between(tip, tip[0], tip.at(-1))} frames`, failures);

  // 4. Reduced motion: the bar jumps.
  await page.evaluate(() => window.__rail.setMotion('reduced'));
  await page.evaluate(() => window.__rail.open('threads'));
  await page.waitForTimeout(200);
  const quiet = await record(() => page.evaluate(() => window.__rail.open('recovery')), 400);
  const quietTops = quiet.filter(sample => sample.bar).map(sample => sample.bar.top);
  assert(between(quietTops, quietTops[0], quietTops.at(-1)) === 0, 'reduced motion: the bar moves at once', failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
