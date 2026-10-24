// Conversation-first process row: one label changing in place, readable
// actions, the running shimmer instead of a spinner, and the closing receipt.
const { openLab, assert } = require('./lab.cjs');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab();
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.process());
  await page.waitForTimeout(800);
  const frames = (await page.evaluate(() => window.__lab.stopRecording())).filter((frame) => frame.activity);
  const ids = [...new Set(frames.map((frame) => frame.activity.id))];
  // Runs of the same visible text, with how long each stayed.
  const runs = [];
  for (const frame of frames) {
    const last = runs.at(-1);
    if (last && last.text === frame.activity.text) last.until = frame.t;
    else {
      // A label lasts until the next one is first seen.
      if (last) last.until = frame.t;
      runs.push({ text: frame.activity.text, from: frame.t, until: frame.t, live: frame.activity.live });
    }
  }
  console.log(runs.map((run) => `${Math.round(run.until - run.from).toString().padStart(5)}ms ${run.live ? 'live ' : '     '}${run.text}`).join('\n'));
  if (process.env.LAB_VERBOSE) {
    let previous = '';
    for (const frame of frames) {
      const line = `${frame.activity.title} | shown=${frame.activity.text} live=${frame.activity.live}`;
      if (line !== previous) console.log(`${Math.round(frame.t)} ${line}`);
      previous = line;
    }
  }
  const middle = runs.slice(0, -1);
  assert(ids.length === 1, `the label keeps one element through the whole segment (${ids.length})`, failures);
  assert(runs.length >= 4, `thinking, actions and the receipt each show (${runs.length} labels)`, failures);
  assert(middle.every((run) => run.until - run.from >= 230), `every label stays readable for ~260ms (shortest ${Math.round(Math.min(...middle.map((run) => run.until - run.from)))}ms)`, failures);
  assert(frames.some((frame) => frame.activity.leaving > 0), 'the old text leaves in the same cell', failures);
  assert(frames.every((frame) => !frame.activity.spinner), 'no spinner: running is the shimmer', failures);
  assert(frames.some((frame) => frame.activity.live) && !frames.at(-1).activity.live, 'the shimmer runs while busy and stops at the receipt', failures);
  assert(/2|·/.test(runs.at(-1).text), `the segment closes on its receipt (${runs.at(-1).text})`, failures);
  assert(errors.filter((error) => !error.includes('404')).length === 0, `no page errors ${JSON.stringify(errors.filter((error) => !error.includes('404')))}`, failures);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall process checks passed');
  process.exit(failures.length ? 1 : 0);
})();
