// Loops stop while nobody can see them (§4): timeline rows scrolled out of view are marked and their
// spinners pause, rows that scroll back in run again, and every loop pauses while the window is hidden.
const { openLab, assert } = require('./lab.cjs');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab();
  await page.evaluate(() => {
    window.__rows = () => {
      const view = document.querySelector('[data-conversation-timeline]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-turn-entry]')].map((row) => {
        const box = row.getBoundingClientRect();
        // The observer's margin is 64px; rows inside it, or straddling it, are not judged.
        const place = box.bottom < view.top - 64 || box.top > view.bottom + 64 ? 'out' : box.bottom > view.top && box.top < view.bottom ? 'in' : 'edge';
        return { place, marked: row.hasAttribute('data-offscreen') };
      });
    };
    window.__spin = (row, name) => {
      const spinner = document.createElement('span');
      spinner.className = 'animate-spin';
      spinner.dataset.labLoop = name;
      spinner.style.display = 'inline-block';
      row.append(spinner);
    };
    window.__playState = (name) => {
      const node = document.querySelector(`[data-lab-loop="${name}"]`);
      return node ? getComputedStyle(node).animationPlayState : 'unmounted';
    };
    window.__hide = (hidden) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await page.waitForTimeout(300);
  const judge = (rows) => rows.filter((row) => row.place !== 'edge').every((row) => row.marked === (row.place === 'out'));
  let rows = await page.evaluate(() => window.__rows());
  assert(rows.some((row) => row.place === 'out') && judge(rows), `rows out of view are marked, rows in view are not (${rows.filter((row) => row.place === 'out').length} out, ${rows.filter((row) => row.place === 'in').length} in)`, failures);

  // A spinner in the nearest row above the viewport, and one in view.
  await page.evaluate(() => {
    const view = document.querySelector('[data-conversation-timeline]').getBoundingClientRect();
    const all = [...document.querySelectorAll('[data-turn-entry]')];
    const above = all.filter((row) => row.getBoundingClientRect().bottom < view.top - 64).at(-1);
    const inside = all.find((row) => { const box = row.getBoundingClientRect(); return box.top > view.top && box.bottom < view.bottom; });
    window.__aboveTop = above.getBoundingClientRect().top;
    window.__spin(above, 'above');
    window.__spin(inside, 'inside');
  });
  await page.waitForTimeout(100);
  const states = await page.evaluate(() => ({ above: window.__playState('above'), inside: window.__playState('inside') }));
  assert(states.above === 'paused' && states.inside === 'running', `a spinner out of view is paused, one in view runs (${JSON.stringify(states)})`, failures);

  // The reader scrolls up until that row is in view.
  const box = await page.evaluate(() => document.querySelector('[data-conversation-timeline]').getBoundingClientRect().toJSON());
  const distance = await page.evaluate(() => document.querySelector('[data-conversation-timeline]').getBoundingClientRect().top - window.__aboveTop + 80);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let moved = 0; moved < distance; moved += 120) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => window.__playState('above'));
  rows = await page.evaluate(() => window.__rows());
  assert(back === 'running' && judge(rows), `scrolled back into view it runs again, and the marks follow the scroll (${back})`, failures);

  await page.evaluate(() => window.__hide(true));
  const hidden = await page.evaluate(() => window.__playState('above'));
  await page.evaluate(() => window.__hide(false));
  const shown = await page.evaluate(() => window.__playState('above'));
  assert(hidden === 'paused' && shown === 'running', `hidden window: loops pause and resume (${hidden} → ${shown})`, failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
