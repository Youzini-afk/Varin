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
  // Wide enough that the chat column is centred with room either side, as on a desktop window.
  const { browser, page, errors } = await openLab({ width: 1400, height: 700, query: '?scene=rail', ready });
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

  // The panel and the canvas move as one: the canvas gives up exactly what the panel takes each frame,
  // the conversation re-wraps at most once and its line starts glide instead of jumping, and the
  // panel's content rides the leading edge.
  const together = (label, frames) => {
    const moving = frames.filter(sample => sample.panel > 0.5);
    const seams = moving.map(sample => sample.edges.panelLeft - sample.edges.mainRight - sample.edges.gap);
    const worst = Math.max(...seams.map(Math.abs));
    assert(moving.length >= 5 && worst < 1, `${label}: no gap or overlap between canvas and panel in ${moving.length} frames (worst ${worst.toFixed(2)}px)`, failures);
    const widths = [...new Set(frames.filter(sample => sample.column).map(sample => Math.round(sample.column.width)))];
    assert(widths.length <= 2, `${label}: the conversation re-wraps at most once (${widths.join(' → ')})`, failures);
    const starts = frames.filter(sample => sample.column).map(sample => sample.column.left - sample.edges.mainLeft);
    const steps = starts.slice(1).map((value, index) => Math.abs(value - starts[index]));
    if (verbose) console.log(`${label} line starts:`, starts.map(Math.round).join(' '), '| panel:', frames.map(sample => Math.round(sample.panel)).join(' '));
    const travel = Math.abs(starts.at(-1) - starts[0]);
    // No single frame carries more than a quarter of the way (headless runs at about 30fps).
    assert(travel > 8 && Math.max(...steps) < travel / 4 && between(starts, starts[0], starts.at(-1)) >= 3, `${label}: line starts glide from ${Math.round(starts[0])} to ${Math.round(starts.at(-1))}px (largest step ${Math.max(...steps).toFixed(1)}px)`, failures);
    const riding = moving.filter(sample => sample.content).map(sample => sample.content.left - sample.edges.panelLeft);
    assert(riding.every(offset => offset > -0.5 && offset < 29), `${label}: the panel's content rides its leading edge (offsets ${Math.round(Math.min(...riding))}–${Math.round(Math.max(...riding))}px)`, failures);
    return moving;
  };
  const panelOpen = await record(() => page.evaluate(() => window.__rail.open('context')), 900);
  const panels = panelOpen.map(sample => sample.panel);
  assert(between(panels, panels[0], panels.at(-1)) >= 5, `the panel glides open (${Math.round(panels[0])} → ${Math.round(panels.at(-1))}px)`, failures);
  const opened = together('open', panelOpen);
  assert(opened.filter(sample => sample.panel > panels.at(-1) * 0.3).every(sample => sample.content.opacity > 0.9), 'open: the content is solid while it slides in', failures);
  const panelClose = await record(() => page.evaluate(() => window.__rail.close()), 1100);
  const closed = together('close', panelClose);
  const early = closed.slice(0, Math.max(1, Math.floor(closed.length / 3)));
  assert(early.every(sample => sample.content.opacity > 0.9), 'close: the content stays readable as it leaves and fades only at the end', failures);

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
