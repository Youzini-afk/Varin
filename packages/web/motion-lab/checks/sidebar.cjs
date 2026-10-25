// Sidebar (§3.10): the selection travels between rows and hands back to the
// row, rows slide when pinned, a new session settles in, a removed one leaves
// to the left while the rest close up, a collapsing project folds and the
// group below slides up, status icons change in place, and one hover
// highlight follows the pointer.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__sidebar && document.querySelector('[data-sidebar-row]');

const recordWhile = async (page, action, ms) => {
  await page.evaluate(() => window.__sidebar.record());
  await page.evaluate(action);
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__sidebar.stopRecording());
};
const topOf = (sample, id) => sample.rows.find(row => row.id === id)?.top;
const between = (values, from, to) => values.filter(value => value > Math.min(from, to) + 1 && value < Math.max(from, to) - 1).length;

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 1100, height: 760, query: '?scene=sidebar', ready });
  await page.waitForTimeout(300);

  // 1. Selection travels from auth-1 to ui-2 and hands back.
  const select = await recordWhile(page, () => window.__sidebar.select('ui-2'), 900);
  const travel = select.filter(sample => sample.selection);
  const from = topOf(select[0], 'auth-1');
  const to = topOf(select.at(-1), 'ui-2');
  if (verbose) console.log('selection:', travel.map(sample => Math.round(sample.selection.top)).join(' '));
  assert(travel.length >= 6 && between(travel.map(sample => sample.selection.top), from, to) >= 4,
    `the selection travels ${Math.round(to - from)}px over ${travel.length} frames`, failures);
  const after = select.at(-1);
  assert(!after.selection && after.current?.id === 'ui-2' && !/rgba\(0, 0, 0, 0\)/.test(after.current.background),
    'it hands back to the row, which paints its own colour', failures);
  // Changing course mid-way carries on from where the copy is.
  const turn = await recordWhile(page, async () => { window.__sidebar.select('auth-3'); await new Promise(resolve => setTimeout(resolve, 120)); window.__sidebar.select('misc-1'); }, 1000);
  const turning = turn.filter(sample => sample.selection).map(sample => sample.selection.top);
  const jumps = turning.slice(1).map((top, index) => Math.abs(top - turning[index]));
  assert(turning.length > 6 && Math.max(...jumps) < 60, `a second click mid-way re-routes without a jump (largest step ${Math.round(Math.max(...jumps))}px)`, failures);

  // 2. Pinning slides the row to the top of its project; the rows above make room.
  // Rows sort newest first, so auth-1 is the last in its project.
  const pin = await recordWhile(page, () => window.__sidebar.pin('auth-1'), 800);
  const pinTops = pin.map(sample => topOf(sample, 'auth-1'));
  if (verbose) console.log('pin:', pinTops.map(Math.round).join(' '));
  assert(pinTops[0] - pinTops.at(-1) > 40 && between(pinTops, pinTops[0], pinTops.at(-1)) >= 4,
    `a pinned row slides ${Math.round(pinTops[0] - pinTops.at(-1))}px up through ${between(pinTops, pinTops[0], pinTops.at(-1))} frames`, failures);

  // 3. A new session settles in at the top of its project; rows below slide down.
  const add = await recordWhile(page, () => window.__sidebar.add('ui-4', '新建的会话', 'p-ui'), 900);
  const arrival = add.map(sample => sample.rows.find(row => row.id === 'ui-4')?.opacity).filter(value => value !== undefined);
  const below = add.map(sample => topOf(sample, 'ui-1'));
  assert(arrival.length > 4 && arrival[0] < 0.6 && arrival.at(-1) > 0.98, `the new row fades in (${arrival[0]?.toFixed(2)} → ${arrival.at(-1)?.toFixed(2)})`, failures);
  assert(between(below, below[0], below.at(-1)) >= 3, 'the rows below slide down to make room', failures);

  // 4. Removing a row: it leaves as a copy while the rows below close up.
  const remove = await recordWhile(page, () => window.__sidebar.remove('auth-2'), 800);
  const ghosts = remove.filter(sample => sample.ghosts > 0).length;
  // After the pin the project reads auth-1, auth-4, auth-3, auth-2: misc rows are below.
  const closing = remove.map(sample => topOf(sample, 'ui-4'));
  assert(ghosts >= 3 && remove.at(-1).ghosts === 0, `the removed row leaves over ${ghosts} frames and is gone after`, failures);
  assert(closing[0] - closing.at(-1) > 20 && between(closing, closing[0], closing.at(-1)) >= 3, `the row below closes the gap by sliding ${Math.round(closing[0] - closing.at(-1))}px`, failures);

  // 5. Collapsing a project folds its rows and slides the next group up.
  const fold = await recordWhile(page, () => {
    const header = [...document.querySelectorAll('section[data-flip-key="group:workspace:p-auth"] button[aria-expanded]')][0];
    header.click();
  }, 800);
  const nextGroup = fold.map(sample => topOf(sample, 'ui-1'));
  assert(nextGroup[0] - nextGroup.at(-1) > 60 && between(nextGroup, nextGroup[0], nextGroup.at(-1)) >= 4,
    `the next project slides up ${Math.round(nextGroup[0] - nextGroup.at(-1))}px as one collapses`, failures);
  const unfold = await recordWhile(page, () => {
    document.querySelector('section[data-flip-key="group:workspace:p-auth"] button[aria-expanded]').click();
  }, 800);
  const firstIn = unfold.map(sample => sample.rows.find(row => row.id === 'auth-1')?.opacity).filter(value => value !== undefined);
  assert(firstIn.length > 3 && firstIn[0] < 0.7 && firstIn.at(-1) > 0.98, 'expanding brings its rows back in', failures);

  // 6. Status icons change in place.
  const busy = await recordWhile(page, () => window.__sidebar.busy('ui-3'), 500);
  const leaving = await page.evaluate(() => document.querySelectorAll('[data-sidebar-row="ui-3"] [data-swap-leaving]').length);
  void busy;
  await page.evaluate(() => window.__sidebar.record());
  await page.evaluate(() => window.__sidebar.busy('ui-3', false));
  await page.waitForTimeout(40);
  const swapping = await page.evaluate(() => document.querySelectorAll('[data-sidebar-row="ui-3"] [data-swap-leaving]').length);
  await page.evaluate(() => window.__sidebar.stopRecording());
  assert(leaving === 0 && swapping === 1, 'the running dot leaves in place while the default icon settles in', failures);

  // 7. One hover highlight follows the pointer between rows.
  const rows = page.locator('[data-sidebar-row]:not([data-current])');
  await rows.nth(1).hover();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__sidebar.record());
  await rows.nth(3).hover();
  await page.waitForTimeout(400);
  const hover = (await page.evaluate(() => window.__sidebar.stopRecording())).filter(sample => sample.hover && sample.hover.opacity > 0.5).map(sample => sample.hover.top);
  if (verbose) console.log('hover:', hover.map(Math.round).join(' '));
  assert(hover.length > 3 && between(hover, hover[0], hover.at(-1)) >= 2, `the hover highlight slides between rows (${between(hover, hover[0], hover.at(-1))} frames between)`, failures);

  // 8. Reduced motion: the selection does not travel and rows do not slide.
  await page.evaluate(() => window.__sidebar.setMotion('reduced'));
  await page.waitForTimeout(100);
  const quiet = await recordWhile(page, () => { window.__sidebar.select('ui-1'); window.__sidebar.pin('ui-2'); }, 500);
  assert(!quiet.some(sample => sample.selection), 'reduced motion: no travelling selection', failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
