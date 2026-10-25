// Session switch (§3.10): the old conversation leaves quickly against the move
// through the list, the new one's turns arrive one after another, and the
// title changes in the same direction.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__switch && document.querySelector('.conversation-scene [data-turn-id]');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 1100, height: 760, query: '?scene=switch', ready });
  await page.waitForTimeout(400);
  const go = async (session, direction) => {
    await page.evaluate(() => window.__switch.record());
    await page.evaluate(([next, step]) => window.__switch.go(next, step), [session, direction]);
    await page.waitForTimeout(700);
    return page.evaluate(() => window.__switch.stopRecording());
  };

  for (const [session, direction, name] of [['乙', 1, 'down'], ['甲', -1, 'up']]) {
    const frames = await go(session, direction);
    const leaving = frames.filter(sample => sample.leaving);
    const gone = frames.findIndex((sample, index) => index > 0 && !sample.leaving && frames[index - 1].leaving);
    const leaveMs = leaving.length && gone > 0 ? frames[gone].t - frames[0].t : Infinity;
    const ys = leaving.map(sample => sample.leaving.y);
    if (verbose) console.log(name, 'leaving:', leaving.map(sample => `${sample.leaving.opacity.toFixed(2)}@${sample.leaving.y.toFixed(1)}`).join(' '));
    assert(leaving.length >= 1 && leaveMs < 260, `${name}: the old conversation leaves in ${Math.round(leaveMs)}ms`, failures);
    assert(ys.some(y => Math.sign(y) === -direction && Math.abs(y) > 1), `${name}: it moves ${direction > 0 ? 'up' : 'down'}, against the move (${ys.map(y => y.toFixed(1)).join(', ')})`, failures);
    // Arriving turns: at some frame, earlier turns are further along than later ones.
    const staggered = frames.some(sample => sample.turns.length > 1 && sample.turns[0] > sample.turns.at(-1) + 0.15);
    const settled = frames.at(-1).turns.every(opacity => opacity > 0.98);
    if (verbose) console.log(name, 'turns:', frames.slice(0, 12).map(sample => sample.turns.map(value => value.toFixed(1)).join('/')).join(' '));
    assert(staggered && settled, `${name}: the new turns arrive one after another and settle`, failures);
    const title = frames.find(sample => sample.title.leaving !== null);
    const later = frames.filter(sample => sample.title.leaving !== null).at(-1);
    const titleMove = title && later ? later.title.leaving - title.title.leaving : 0;
    assert(title && Math.sign(titleMove) === -direction, `${name}: the old title leaves ${direction > 0 ? 'upward' : 'downward'} (${titleMove.toFixed(1)}px)`, failures);
  }

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
