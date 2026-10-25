// Popovers (§3.10): a menu grows from its trigger on snap, its highlight slides
// between items for the pointer and the arrow keys, it leaves on the exit
// tween, and tooltips wait 520ms once and then open at once along a row.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__send && document.querySelector('[data-chat-input-footer] .conversation-composer-options button');

/** Per-frame samples of `read` for `ms`, taken in the page. */
const sample = (page, read, ms) => page.evaluate(({ source, ms }) => new Promise((resolve) => {
  const reader = new Function(`return (${source})()`);
  const frames = [];
  const started = performance.now();
  const tick = () => {
    frames.push({ t: performance.now() - started, ...reader() });
    if (performance.now() - started < ms) requestAnimationFrame(tick); else resolve(frames);
  };
  requestAnimationFrame(tick);
}), { source: read.toString(), ms });

const popupState = () => {
  const popup = document.querySelector('[data-slot="dropdown-menu-content"]');
  if (!popup) return { open: false };
  const style = getComputedStyle(popup);
  return { open: true, opacity: Number(style.opacity), scale: style.scale, translate: style.translate, side: popup.getAttribute('data-side') };
};

const highlightState = () => {
  const popup = document.querySelector('[data-slot="dropdown-menu-content"]');
  const pill = popup?.querySelector('.menu-highlight');
  const item = popup?.querySelector('[role^="menuitem"][data-highlighted]');
  if (!pill) return { pill: null };
  const rect = pill.getBoundingClientRect();
  const target = item?.getBoundingClientRect();
  return {
    pill: { top: rect.top, height: rect.height, opacity: Number(getComputedStyle(pill).opacity) },
    item: target ? { top: target.top, height: target.height, background: getComputedStyle(item).backgroundColor } : null,
  };
};

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ query: '?scene=send', ready });
  const trigger = page.locator('[data-chat-input-footer] .conversation-composer-options button').first();

  // 1. Opening grows from the trigger.
  const opening = sample(page, popupState, 700);
  await trigger.click();
  const open = (await opening).filter(frame => frame.open);
  if (verbose) console.log('open:', open.map(frame => `${frame.opacity.toFixed(2)}/${frame.scale}/${frame.translate}`).join(' '));
  const growing = open.filter(frame => frame.opacity > 0.05 && frame.opacity < 0.95).length;
  assert(growing >= 3 && open.at(-1).opacity > 0.98, `the menu fades and scales in through ${growing} frames (side ${open[0]?.side})`, failures);
  const offset = open.find(frame => frame.translate && frame.translate !== 'none' && frame.translate !== '0px');
  assert(Boolean(offset), `it starts offset toward the trigger (${offset?.translate ?? 'none'})`, failures);

  // 2. The highlight slides between items.
  const items = page.locator('[data-slot="dropdown-menu-content"] [role^="menuitem"]');
  const count = await items.count();
  await items.nth(0).hover();
  await page.waitForTimeout(250);
  const first = await page.evaluate(highlightState);
  assert(first.pill && first.item && Math.abs(first.pill.top - first.item.top) < 1 && first.pill.opacity > 0.9,
    `the highlight sits on the hovered item (${count} items)`, failures);
  assert(first.item && /rgba\(0, 0, 0, 0\)|transparent/.test(first.item.background), `the item does not paint its own highlight (${first.item?.background})`, failures);
  const sliding = sample(page, highlightState, 420);
  await items.nth(Math.min(2, count - 1)).hover();
  const slide = (await sliding).filter(frame => frame.pill && frame.item);
  const tops = slide.map(frame => frame.pill.top);
  const between = tops.filter(top => top > Math.min(tops[0], tops.at(-1)) + 1 && top < Math.max(tops[0], tops.at(-1)) - 1).length;
  if (verbose) console.log('slide:', tops.map(Math.round).join(' '));
  assert(between >= 2 && Math.abs(slide.at(-1).pill.top - slide.at(-1).item.top) < 1, `it slides to the next item through ${between} frames and lands on it`, failures);
  const keyed = sample(page, highlightState, 420);
  await page.keyboard.press('ArrowUp');
  const keys = (await keyed).filter(frame => frame.pill && frame.item);
  assert(keys.length > 0 && Math.abs(keys.at(-1).pill.top - keys.at(-1).item.top) < 1, 'the arrow keys move it too', failures);

  // 3. Leaving is quicker than arriving.
  const closing = sample(page, popupState, 300);
  await page.keyboard.press('Escape');
  const close = await closing;
  if (verbose) console.log('close:', close.map(frame => frame.open ? `${Math.round(frame.t)}:${frame.opacity.toFixed(2)}/${frame.scale}` : `${Math.round(frame.t)}:gone`).join(' '));
  const gone = close.findIndex(frame => !frame.open);
  const closeMs = gone >= 0 ? close[gone].t : Infinity;
  const fading = close.filter(frame => frame.open && frame.opacity < 1 && frame.opacity > 0).length;
  assert(gone >= 0 && closeMs < 260 && fading >= 1, `the menu leaves in ${Math.round(closeMs)}ms, fading through ${fading} frames`, failures);

  // 4. Tooltips: one wait, then a neighbour opens at once. Timed in the page:
  // from entering an anchor to its tooltip appearing.
  await page.mouse.move(600, 400);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.__tips = [];
    const anchors = [...document.querySelectorAll('[data-lab-tooltips] button')];
    anchors.forEach((anchor, index) => anchor.addEventListener('pointerenter', () => { window.__tips[index] = { entered: performance.now() }; }));
    new MutationObserver(() => {
      anchors.forEach((anchor, index) => {
        const tip = window.__tips[index];
        if (tip && !tip.shown && anchor.hasAttribute('data-popup-open')) tip.shown = performance.now();
      });
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-popup-open'] });
  });
  const tips = page.locator('[data-lab-tooltips] button');
  await tips.nth(0).hover();
  await page.waitForTimeout(900);
  await tips.nth(1).hover();
  await page.waitForTimeout(500);
  const timing = await page.evaluate(() => window.__tips.map(tip => tip && tip.shown ? Math.round(tip.shown - tip.entered) : null));
  assert(timing[0] !== null && timing[0] >= 480 && timing[0] < 700, `the first tooltip waits ${timing[0]}ms`, failures);
  assert(timing[1] !== null && timing[1] < 120, `its neighbour opens without waiting (${timing[1]}ms)`, failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
