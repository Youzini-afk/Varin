// Mobile edge swipe (§3.14): the chat follows the finger from the edge, a throw leaves the way it was
// thrown and switches session with the next one coming in from the side the finger started on, a
// short slow pull springs home on glide, and a vertical drag at the edge is left to scrolling.
// Each drag runs on a fresh page: CDP keeps touch points between sequences on one page.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__mobile && document.querySelector('[data-mobile-surface]');

const run = async (points, gapMs, settleMs, errors) => {
  const lab = await openLab({ width: 390, height: 844, query: '?scene=mobile', ready, hasTouch: true });
  const cdp = await lab.page.context().newCDPSession(lab.page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await lab.page.evaluate(() => window.__mobile.record());
  const [first, ...rest] = points;
  await touch('touchStart', first[0], first[1]);
  for (const [x, y] of rest) {
    await lab.page.waitForTimeout(gapMs);
    await touch('touchMove', x, y);
  }
  await touch('touchEnd', 0, 0);
  await lab.page.waitForTimeout(settleMs);
  const frames = await lab.page.evaluate(() => window.__mobile.stopRecording());
  errors.push(...lab.errors);
  await lab.browser.close();
  return { frames, fingers: rest.map(([x]) => x - first[0]) };
};

(async () => {
  const failures = [];
  const errors = [];

  {
    const { frames, fingers } = await run([[4, 420], [24, 421], [64, 422], [110, 423], [160, 424], [210, 424]], 16, 1000, errors);
    if (verbose) console.log('throw', frames.map(sample => `${sample.thread}:${sample.x.toFixed(0)}/${sample.opacity.toFixed(2)}`).join(' '));
    // Headless delivers touch moves frame-aligned and sometimes a frame late, so compare positions,
    // not timing: every place the content was drawn during the drag is exactly where a finger was.
    const drawn = [...new Set(frames.filter(sample => sample.thread === 't1' && sample.opacity > 0.8 && sample.x > 0.5).map(sample => Math.round(sample.x)))];
    assert(drawn.length >= 3 && drawn.every(x => fingers.some(dx => Math.abs(dx - x) < 1.5)), `throw: the content follows the finger one to one (drawn at ${drawn.join(', ')}; finger at ${fingers.join(', ')})`, failures);
    const leftAt = frames.findIndex(sample => sample.x > 215);
    const enteredAt = frames.findIndex((sample, index) => index > leftAt && sample.x < -20);
    assert(leftAt >= 0 && frames[leftAt].opacity < 0.7 && frames[leftAt].thread === 't1', 'throw: it carries on rightward and fades before the session changes', failures);
    assert(frames.at(-1).thread === 't3', `throw: switched to the previous session (${frames.at(-1).thread})`, failures);
    assert(enteredAt > leftAt && frames[enteredAt].thread === 't3', 'throw: the next session comes in from the left', failures);
    const last = frames.at(-1);
    assert(Math.abs(last.x) < 0.5 && last.opacity > 0.99, 'throw: it settles in place', failures);
    const entering = frames.slice(enteredAt);
    const steps = entering.slice(1).map((sample, index) => sample.x - entering[index].x);
    assert(entering.length > 6 && steps.every(step => step > -0.5), `throw: the entrance glides in over ${entering.length} frames without stepping back`, failures);
  }

  {
    const { frames } = await run([[386, 420], [374, 420], [360, 421], [345, 421], [330, 422]], 70, 900, errors);
    if (verbose) console.log('pull', frames.map(sample => `${sample.thread}:${sample.x.toFixed(0)}`).join(' '));
    const pulled = Math.min(...frames.map(sample => sample.x));
    const home = frames.slice(frames.findIndex(sample => sample.x === pulled));
    assert(pulled < -40 && pulled > -60, `pull: the content was pulled ${pulled.toFixed(0)}px`, failures);
    assert(frames.every(sample => sample.thread === 't1'), 'pull: no switch', failures);
    assert(home.length > 6 && Math.abs(home.at(-1).x) < 0.5 && home.every(sample => sample.x <= 0.5), `pull: it springs home over ${home.length} frames without overshooting`, failures);
  }

  {
    const { frames } = await run([[4, 300], [6, 330], [8, 370], [40, 420]], 20, 300, errors);
    assert(frames.every(sample => Math.abs(sample.x) < 0.5 && sample.thread === 't1'), 'vertical: left to scrolling', failures);
  }

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
