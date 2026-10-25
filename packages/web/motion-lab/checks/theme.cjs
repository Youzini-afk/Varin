// Theme ink (§3.12): a theme change spreads as a circle from the click through
// a View Transition; reduced motion cross-fades; off switches directly.
// Headless screenshots do not capture View Transition snapshots, so this
// checks the transition and its clip animation rather than pixels.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 1100, height: 760 });
  await page.waitForFunction(() => window.__theme);
  // View Transition pseudo-element animations are not listed by getAnimations(); record the calls.
  await page.evaluate(() => {
    window.__inks = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function patched(keyframes, options) {
      if (options && typeof options === 'object' && options.pseudoElement) {
        window.__inks.push({ pseudo: options.pseudoElement, clip: String(keyframes?.clipPath?.[0] ?? ''), end: String(keyframes?.clipPath?.[1] ?? ''), duration: options.duration });
      }
      return animate.call(this, keyframes, options);
    };
  });
  const opposite = () => page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'light' : 'dark'));
  const switchAt = async (x, y) => {
    const mode = await opposite();
    await page.mouse.click(x, y);
    const frames = await page.evaluate(next => new Promise((resolve) => {
      const seen = [];
      window.__inks.length = 0;
      window.__theme.mode(next);
      const started = performance.now();
      const tick = () => {
        seen.push({ ink: document.documentElement.dataset.themeInk ?? null, dark: document.documentElement.classList.contains('dark') });
        if (performance.now() - started < 1500) requestAnimationFrame(tick); else resolve({ seen, inks: [...window.__inks] });
      };
      requestAnimationFrame(tick);
    }), mode);
    return { mode, ...frames };
  };

  assert(await page.evaluate(() => typeof document.startViewTransition === 'function'), 'this browser has View Transitions', failures);
  const full = await switchAt(200, 150);
  const circle = full.inks.find(call => call.pseudo === '::view-transition-new(root)');
  if (verbose) console.log('ink:', JSON.stringify(circle), 'frames:', full.seen.filter((_, index) => index % 4 === 0).map(frame => `${frame.ink}/${frame.dark ? 'd' : 'l'}`).join(' '));
  assert(full.seen.some(frame => frame.ink === 'circle') && circle && /circle\(0px at 200px 150px\)/.test(circle.clip) && circle.duration === 660,
    `the new theme spreads from the click over 660ms (${circle ? `${circle.clip} → ${circle.end}` : 'no clip animation'})`, failures);
  assert(full.seen.at(-1).dark === (full.mode === 'dark') && full.seen.at(-1).ink === null, `it ends in the ${full.mode} theme with the transition cleared`, failures);

  await page.evaluate(() => window.__lab.setMotion('reduced'));
  await page.waitForTimeout(100);
  const reduced = await switchAt(500, 400);
  assert(reduced.seen.some(frame => frame.ink === 'fade') && reduced.inks.length === 0, 'reduced motion cross-fades without the circle', failures);
  await page.evaluate(() => window.__lab.setMotion('off'));
  await page.waitForTimeout(100);
  const off = await switchAt(500, 400);
  const flipped = off.seen.findIndex(frame => frame.dark === (off.mode === 'dark'));
  assert(!off.seen.some(frame => frame.ink) && flipped >= 0 && flipped <= 2, `off switches directly (from frame ${flipped})`, failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
