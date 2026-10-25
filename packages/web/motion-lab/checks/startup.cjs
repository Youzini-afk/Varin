// Startup (§3.13): a warm start's splash dissolves in about 440ms instead of 1.9s, and the parts
// under it arrive 40ms apart (sidebar, title bar, home title, composer, rail), the starters after
// them one by one. A splash that has been up a while keeps the full exit and plays no entrance;
// reduced motion fades the cover once and plays no entrance either.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__startup && document.getElementById('initial-loading');
const PARTS = ['sidebar', 'header', 'hero', 'composer', 'rail'];

const firstAt = (frames, predicate) => frames.find(predicate)?.t;

(async () => {
  const failures = [];
  const errors = [];

  {
    const lab = await openLab({ width: 1280, height: 800, query: '?scene=startup', ready });
    await lab.page.evaluate(() => window.__startup.record());
    const start = await lab.page.evaluate(() => window.__startup.dismiss(500));
    await lab.page.waitForTimeout(1400);
    const frames = await lab.page.evaluate(() => window.__startup.stopRecording());
    const after = frames.filter(sample => sample.t >= start);
    if (verbose) {
      console.log('splash', after.map(sample => `${Math.round(sample.t - start)}:${sample.splash === null ? '-' : sample.splash.toFixed(2)}`).join(' '));
      for (const part of PARTS) console.log(part, after.slice(0, 22).map(sample => `${sample.parts[part].opacity.toFixed(2)}@${sample.parts[part].x.toFixed(0)},${sample.parts[part].y.toFixed(0)}`).join(' '));
      console.log('starters', after.slice(0, 26).map(sample => sample.starters.map(value => value.toFixed(1)).join('/')).join(' '));
    }
    assert(after[0]?.exit === 'warm' && after[0]?.entrance, 'warm: the splash takes the warm exit and the entrance starts', failures);
    const gone = firstAt(after, sample => sample.splash === null);
    assert(gone !== undefined && gone - start < 640, `warm: the splash is gone ${Math.round(gone - start)}ms after the exit starts`, failures);
    const fading = after.filter(sample => sample.splash !== null && sample.splash > 0.05 && sample.splash < 0.95);
    assert(fading.length >= 2, `warm: the cover dissolves over ${fading.length} frames rather than cutting`, failures);
    const arrived = PARTS.map(part => firstAt(after, sample => sample.parts[part].opacity >= 0.5));
    if (verbose) console.log('half-way', PARTS.map((part, index) => `${part}@${Math.round(arrived[index] - start)}`).join(' '));
    assert(arrived.every(Boolean) && arrived.every((t, index) => index === 0 || t >= arrived[index - 1]), `warm: the parts arrive in order (${arrived.map(t => Math.round(t - start)).join(', ')}ms)`, failures);
    assert(arrived.at(-1) - arrived[0] >= 100, `warm: the stagger spans ${Math.round(arrived.at(-1) - arrived[0])}ms`, failures);
    const moved = {
      sidebar: after.some(sample => sample.parts.sidebar.x < -2),
      header: after.some(sample => sample.parts.header.y < -1),
      composer: after.some(sample => sample.parts.composer.y > 2),
      rail: after.some(sample => sample.parts.rail.x > 2),
    };
    assert(Object.values(moved).every(Boolean), `warm: each part comes from its own side (${JSON.stringify(moved)})`, failures);
    const startersHalf = [0, 1, 2, 3, 4].map(index => firstAt(after, sample => (sample.starters[index] ?? 0) >= 0.5));
    assert(startersHalf.every(Boolean) && startersHalf[0] >= arrived.at(-1) - 20 && startersHalf.every((t, index) => index === 0 || t >= startersHalf[index - 1]), `warm: the starters follow one by one (${startersHalf.map(t => Math.round(t - start)).join(', ')}ms)`, failures);
    const last = after.at(-1);
    assert(!last.entrance && PARTS.every(part => last.parts[part].opacity > 0.99 && Math.abs(last.parts[part].x) < 0.5 && Math.abs(last.parts[part].y) < 0.5), 'warm: everything settles and the entrance is cleared', failures);
    errors.push(...lab.errors);
    await lab.browser.close();
  }

  {
    const lab = await openLab({ width: 1280, height: 800, query: '?scene=startup', ready });
    await lab.page.evaluate(() => window.__startup.record());
    const start = await lab.page.evaluate(() => window.__startup.dismiss(5000));
    await lab.page.waitForTimeout(2300);
    const frames = (await lab.page.evaluate(() => window.__startup.stopRecording())).filter(sample => sample.t >= start);
    const gone = firstAt(frames, sample => sample.splash === null);
    assert(frames[0]?.exit === null && frames.every(sample => !sample.entrance), 'cold: the full exit, no staged entrance', failures);
    assert(gone !== undefined && gone - start >= 1850, `cold: the full exit keeps its ${Math.round(gone - start)}ms`, failures);
    errors.push(...lab.errors);
    await lab.browser.close();
  }

  {
    const lab = await openLab({ width: 1280, height: 800, query: '?scene=startup', ready, reducedMotion: 'reduce' });
    await lab.page.evaluate(() => window.__startup.record());
    const start = await lab.page.evaluate(() => window.__startup.dismiss(500));
    await lab.page.waitForTimeout(700);
    const frames = (await lab.page.evaluate(() => window.__startup.stopRecording())).filter(sample => sample.t >= start);
    const gone = firstAt(frames, sample => sample.splash === null);
    assert(frames.every(sample => !sample.entrance && sample.exit === null), 'reduced: no warm exit and no entrance', failures);
    assert(gone !== undefined && gone - start < 420, `reduced: the cover fades once and is gone after ${Math.round(gone - start)}ms`, failures);
    errors.push(...lab.errors);
    await lab.browser.close();
  }

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
