// File change card: paced streaming diff with row identity, no overlapping
// rows, an overwrite cursor, the late path, phases and the settled diff.
const { openLab, assert } = require('./lab.cjs');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab();
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.fileEdit({ pathLast: true }));
  await page.waitForTimeout(600);
  const frames = (await page.evaluate(() => window.__lab.stopRecording())).filter((frame) => frame.card);
  let overlaps = 0;
  let worst = 0;
  for (const frame of frames) {
    // A reordered row waits invisible, then fades in at its place; only rows
    // that can be seen count.
    const rows = frame.card.rows.filter((row) => row.opacity >= 0.3).sort((a, b) => a.top - b.top);
    for (let index = 1; index < rows.length; index += 1) {
      const overlap = rows[index - 1].bottom - rows[index].top;
      // Two springs started a frame apart can differ by a hairline.
      if (overlap > 2.5) {
        overlaps += 1;
        worst = Math.max(worst, overlap);
        if (process.env.LAB_VERBOSE) console.log(`${Math.round(frame.t)} ${rows.map((row) => `${row.key}:${row.kind}${row.pending ? '*' : ''}@${row.top.toFixed(1)}-${row.bottom.toFixed(1)}`).join(' ')}`);
      }
    }
  }
  const phases = [...new Set(frames.map((frame) => frame.card.phase))];
  const names = [...new Set(frames.map((frame) => frame.card.name))];
  const rowCounts = frames.map((frame) => frame.card.rows.length);
  const growthFrames = rowCounts.filter((count, index) => index && count !== rowCounts[index - 1]).length;
  const typed = frames.some((frame) => frame.card.rows.some((row) => row.kind === 'context' && row.pending));
  const ahead = frames.some((frame) => frame.card.rows.some((row) => row.ahead));
  const caret = frames.some((frame) => frame.card.rows.some((row) => row.caret));
  const final = frames.at(-1).card;
  const heights = frames.map((frame) => frame.card.height);
  const heightJumps = heights.slice(1).filter((height, index) => Math.abs(height - heights[index]) > 23).length;
  console.log(JSON.stringify({ frames: frames.length, phases, names, growthFrames, overlaps, worst, typed, ahead, caret, remounts: final.remounts,
    ghostsSeen: Math.max(...frames.map((frame) => frame.card.ghosts)), heightJumps, final: final.rows.map((row) => `${row.key}:${row.kind}`) }));
  assert(overlaps === 0, `no visible rows overlap while rows move (${overlaps} overlaps, worst ${worst.toFixed(1)}px)`, failures);
  assert(final.remounts === 0, `rows keep their elements through the stream and settle (${final.remounts} remounts)`, failures);
  assert(growthFrames >= 6, `rows grow over many frames (${growthFrames})`, failures);
  assert(typed, 'a line written over an old one shows as an overwrite', failures);
  assert(ahead, 'undecided old lines after the cursor show faded', failures);
  assert(caret, 'the line being written carries the cursor', failures);
  assert(names[0] !== 'login.ts' && names.includes('login.ts'), `the late path arrives in place (${names.join(' → ')})`, failures);
  assert(phases.includes('generating') && phases.includes('applying') && phases.at(-1) === 'applied', `phases advance in place (${phases.join(' → ')})`, failures);
  assert(heightJumps === 0, `the frame height glides instead of jumping (${heightJumps} jumps)`, failures);
  assert(final.rows.every((row) => !row.pending && !row.ahead && !row.caret), 'the settled diff has no cursor or pending rows', failures);
  assert(final.rows.some((row) => row.kind === 'add') && final.rows.some((row) => row.kind === 'remove'), 'the settled diff shows additions and removals', failures);
  assert(errors.filter((error) => !error.includes('404')).length === 0, `no page errors ${JSON.stringify(errors.filter((error) => !error.includes('404')))}`, failures);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall file card checks passed');
  process.exit(failures.length ? 1 : 0);
})();
