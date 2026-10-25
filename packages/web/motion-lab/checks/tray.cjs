// Conversation-first tray: changes show under the folded row while they work,
// concurrent writes retract together after reading time, a later write opens a
// new batch, pointing into the tray holds it, and the segment end retracts it.
const { openLab, assert } = require('./lab.cjs');

const sequence = (frames) => {
  const seen = [];
  for (const frame of frames) {
    const key = frame.tray.join(' + ');
    if (seen.at(-1)?.key !== key) seen.push({ key, from: frame.t, cards: frame.tray.length });
  }
  return seen;
};

(async () => {
  const failures = [];

  // 1. Unattended: the batches open and retract on their own.
  let { browser, page, errors } = await openLab();
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.tray());
  await page.waitForTimeout(900);
  let frames = await page.evaluate(() => window.__lab.stopRecording());
  let runs = sequence(frames);
  console.log(runs.map((run) => `${Math.round(run.from)} [${run.key}]`).join('\n'));
  const counts = runs.map((run) => run.cards);
  const pair = runs.findIndex((run) => run.cards === 2);
  assert(JSON.stringify(counts) === JSON.stringify([0, 1, 2, 0, 1, 0]), `tray cards go 0 → 1 → 2 → 0 → 1 → 0 (${counts.join(' → ')})`, failures);
  assert(pair > 0 && runs[pair + 1]?.cards === 0, 'the concurrent pair retracts together, never one by one', failures);
  const pairDone = await page.evaluate(() => window.__trayPairDone);
  // The retraction starts when the tray first gets shorter after the pair is
  // done; the cards then stay mounted while it folds.
  const settledHeight = Math.max(...frames.filter((frame) => frame.t >= pairDone && frame.tray.length === 2).map((frame) => frame.trayHeight));
  const foldStart = frames.find((frame) => frame.t >= pairDone && frame.tray.length === 2 && frame.trayHeight < settledHeight - 1);
  const retractAfter = foldStart ? foldStart.t - pairDone : 0;
  console.log(JSON.stringify({ retractAfterMs: Math.round(retractAfter), foldMs: foldStart && pair > 0 ? Math.round(runs[pair + 1].from - foldStart.t) : null }));
  assert(retractAfter >= 650 && retractAfter < 950, `the pair stays ~700ms after both finish, then retracts (${Math.round(retractAfter)}ms)`, failures);
  const shrink = frames.filter((frame) => frame.t > pairDone && frame.t < runs[pair + 1].from + 50 && frame.trayHeight > 0).map((frame) => frame.trayHeight);
  assert(shrink.length >= 3, `the tray height folds away over several frames (${shrink.length})`, failures);
  assert(errors.filter((error) => !error.includes('404')).length === 0, `no page errors ${JSON.stringify(errors.filter((error) => !error.includes('404')))}`, failures);
  await browser.close();

  // 2. Pointing into the tray holds the batch; a later write joins it.
  ({ browser, page, errors } = await openLab());
  await page.evaluate(() => window.__lab.record());
  const running = page.evaluate(() => window.__lab.tray());
  await page.waitForFunction(() => window.__trayPairDone, null, { timeout: 15000 });
  await page.locator('[data-conversation-file-tray]').last().hover();
  await page.waitForTimeout(1400);
  const held = await page.evaluate(() => [...document.querySelectorAll('[data-conversation-file-tray] [data-conversation-file-preview]')].map((node) => node.getAttribute('data-conversation-file-preview')));
  await page.mouse.move(8, 8);
  await running;
  await page.waitForTimeout(900);
  frames = await page.evaluate(() => window.__lab.stopRecording());
  runs = sequence(frames);
  console.log(JSON.stringify({ held, runs: runs.map((run) => run.key) }));
  assert(held.length === 3, `held past the linger, the next write joins the same batch (${held.join(', ')})`, failures);
  assert(runs.at(-1).cards === 0, 'after leaving, the batch retracts', failures);
  await browser.close();

  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall tray checks passed');
  process.exit(failures.length ? 1 : 0);
})();
