// Workbench switch (§3.11): the lattice grows out of the switcher until it covers the window, the
// Shell commits only under a closed lattice, and a second wave opens it again (outward going
// forward, back toward the switcher going back). The scene finishes each phase itself, before Core's
// declared clock. A slow commit holds the cover and says what it is waiting for.
// `node workbench.cjs [out-dir]` also writes a few frames of the cover for review.
const path = require('node:path');
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const outDir = process.argv[2];
const ready = () => window.__wb && document.querySelector('[data-lab-layout]');
const COVER_MS = 380;
const REVEAL_MS = 400;
const DECLARED_COVER_MS = 580;
const DECLARED_REVEAL_MS = 600;

const at = (marks, event) => marks.find(mark => mark.event === event)?.t;
// Mean scale of the nearest and farthest fifth of the sampled cells.
const ends = (sample) => {
  const fifth = Math.max(1, Math.floor(sample.scales.length / 5));
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  return { near: mean(sample.scales.slice(0, fifth)), far: mean(sample.scales.slice(-fifth)) };
};

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 1280, height: 800, query: '?scene=workbench', ready });
  // LAB_THEME=dark reviews the cover on the dark theme.
  if (process.env.LAB_THEME) {
    await page.evaluate((mode) => window.__theme.mode(mode), process.env.LAB_THEME);
    await page.waitForTimeout(900);
  }
  const go = async (profile, options = {}, waitMs = 1500, shots = []) => {
    await page.evaluate(() => window.__wb.record());
    const started = Date.now();
    const done = page.evaluate(([next, opts]) => window.__wb.go(next, opts), [profile, options]);
    for (const [moment, name] of shots) {
      await page.waitForTimeout(Math.max(0, moment - (Date.now() - started)));
      await page.screenshot({ path: path.resolve(outDir, `workbench-${process.env.LAB_THEME ?? 'light'}-${name}.png`) });
    }
    await done;
    await page.waitForTimeout(Math.max(0, waitMs - (Date.now() - started)));
    return page.evaluate(() => window.__wb.stopRecording());
  };

  const forward = await go('ide', {}, 1500, outDir ? [[120, 'cover-120'], [260, 'cover-260'], [560, 'reveal-560']] : []);
  {
    const { frames, marks } = forward;
    const begin = at(marks, 'covering');
    const covered = at(marks, 'covered');
    const revealing = at(marks, 'revealing');
    const idle = marks.filter(mark => mark.event === 'idle').at(-1)?.t;
    if (verbose) {
      console.log('marks', marks.map(mark => `${mark.event}@${Math.round(mark.t - begin)}`).join(' '));
      console.log('near/far', frames.filter(sample => sample.scales.length).map(sample => {
        const { near, far } = ends(sample);
        return `${sample.phase[0]}${Math.round(sample.t - begin)}:${near.toFixed(2)}/${far.toFixed(2)}`;
      }).join(' '));
    }
    const coverMs = covered - begin;
    assert(coverMs >= COVER_MS - 40 && coverMs < DECLARED_COVER_MS, `forward: the lattice closes itself in ${Math.round(coverMs)}ms (wave ${COVER_MS}, Core clock ${DECLARED_COVER_MS})`, failures);
    const revealMs = idle - revealing;
    assert(revealMs >= REVEAL_MS - 40 && revealMs < DECLARED_REVEAL_MS, `forward: it opens itself in ${Math.round(revealMs)}ms (wave ${REVEAL_MS}, Core clock ${DECLARED_REVEAL_MS})`, failures);
    const growing = frames.filter(sample => sample.phase === 'covering' && sample.scales.length);
    assert(growing.some(sample => { const { near, far } = ends(sample); return near > far + 0.4; }), 'forward: cells near the switcher close first', failures);
    const ideUnderOpenCells = frames.filter(sample => sample.layout === 'ide' && sample.phase !== 'revealing' && sample.phase !== 'idle')
      .filter(sample => sample.scales.some(scale => scale < 1.0));
    assert(ideUnderOpenCells.length === 0 && frames.some(sample => sample.layout === 'ide'), 'forward: IDE commits only while every sampled cell is closed', failures);
    const opening = frames.filter(sample => sample.phase === 'revealing' && sample.scales.length);
    assert(opening.some(sample => { const { near, far } = ends(sample); return near < far - 0.4; }), 'forward: it opens outward from the switcher', failures);
    const last = frames.at(-1);
    assert(last.phase === 'idle' && last.layout === 'ide', 'forward: the overlay is gone and IDE stays', failures);
  }

  const back = await go('workbench');
  {
    const opening = back.frames.filter(sample => sample.phase === 'revealing' && sample.scales.length);
    assert(opening.some(sample => { const { near, far } = ends(sample); return near > far + 0.4; }), 'back: it opens from the edges and closes toward the switcher', failures);
    assert(back.frames.at(-1).layout === 'workbench' && back.frames.at(-1).phase === 'idle', 'back: 工作台 is back and the overlay is gone', failures);
  }

  const slow = await go('ide', { holdMs: 1100 }, 2300, outDir ? [[1250, 'hold']] : []);
  {
    const covered = at(slow.marks, 'covered');
    const revealing = at(slow.marks, 'revealing');
    const before = slow.frames.filter(sample => sample.t < covered + 500);
    const holding = slow.frames.filter(sample => sample.t > covered + 800 && sample.t < revealing);
    assert(before.every(sample => sample.hold < 0.05), 'slow: no notice during a short hold', failures);
    assert(holding.some(sample => sample.hold > 0.9), 'slow: a long hold shows what it is switching to', failures);
    assert(slow.frames.filter(sample => sample.t > covered && sample.t < revealing).every(sample => sample.scales.every(scale => scale >= 1)), 'slow: the cover stays closed for the whole hold', failures);
    assert(slow.frames.at(-1).phase === 'idle', 'slow: it still finishes', failures);
  }

  await browser.close();

  // Reduced motion: one sheet fades in and out; no cells.
  {
    const lab = await openLab({ width: 1280, height: 800, query: '?scene=workbench', ready, reducedMotion: 'reduce' });
    await lab.page.evaluate(() => window.__wb.record());
    await lab.page.evaluate(() => window.__wb.go('ide'));
    await lab.page.waitForTimeout(500);
    const { frames, marks } = await lab.page.evaluate(() => window.__wb.stopRecording());
    const coverMs = at(marks, 'covered') - at(marks, 'covering');
    if (verbose) console.log('reduced sheet', frames.map(sample => sample.sheet?.toFixed(2)).join(' '));
    assert(frames.every(sample => sample.scales.length === 0), 'reduced: no lattice cells', failures);
    assert(frames.some(sample => sample.sheet !== null && sample.sheet > 0.05 && sample.sheet < 0.95), 'reduced: the sheet fades', failures);
    assert(coverMs < 280, `reduced: covered in ${Math.round(coverMs)}ms`, failures);
    assert(frames.at(-1).phase === 'idle' && frames.at(-1).layout === 'ide', 'reduced: finishes on IDE', failures);
    errors.push(...lab.errors);
    await lab.browser.close();
  }

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
