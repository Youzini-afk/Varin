// Send choreography on the empty home and in a docked conversation (§3.1):
// the title rises away and starters sink while the composer docks on travel,
// the button icon swaps in place, the message flies into its bubble on a
// shallow arc and lands on the frame it meets the live bubble, and a cleared
// composer glides back down.
const { openLab, assert } = require('./lab.cjs');

const verbose = process.env.LAB_VERBOSE === '1';
const ready = () => window.__send && document.querySelector('[data-conversation-composer-input-frame] .cm-content');

async function type(page, lines) {
  await page.click('[data-conversation-composer-input-frame] .cm-content');
  for (const [index, line] of lines.entries()) {
    if (index) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(line);
  }
  await page.waitForTimeout(300);
}

async function recordWhile(page, action, waitMs) {
  await page.evaluate(() => window.__send.record());
  await action();
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => window.__send.stopRecording());
}

/** Flight frames, the last one and the frame after, and how often x led y. */
function flight(samples) {
  const flying = samples.filter(sample => sample.overlay && sample.bubble);
  const lastIndex = samples.findLastIndex(sample => sample.overlay);
  const last = samples[lastIndex];
  const after = samples[lastIndex + 1];
  let arc = 0;
  const first = flying[0];
  if (first) {
    const end = last.bubble;
    for (const sample of flying.slice(1, -1)) {
      const x = Math.abs(end.left - first.overlay.left) > 4 ? (sample.overlay.left - first.overlay.left) / (end.left - first.overlay.left) : 1;
      const y = Math.abs(end.top - first.overlay.top) > 4 ? (sample.overlay.top - first.overlay.top) / (end.top - first.overlay.top) : 1;
      if (x > y + 0.04) arc += 1;
    }
  }
  const gap = last && last.bubble ? Math.max(
    Math.abs(last.overlay.left - last.bubble.left), Math.abs(last.overlay.top - last.bubble.top),
    Math.abs(last.overlay.width - last.bubble.width), Math.abs(last.overlay.height - last.bubble.height),
  ) : Infinity;
  return { flying, last, after, arc, gap };
}

const largestStep = (values) => values.slice(1).reduce((largest, value, index) => Math.max(largest, Math.abs(value - values[index])), 0);
const describe = (samples) => samples.map(sample => `${Math.round(sample.frame?.top ?? -1)}/${Math.round(sample.frame?.height ?? -1)}${sample.frame?.gliding ? '*' : ''}`).join(' ');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ query: '?scene=send', ready });
  await page.evaluate(() => window.__send.configure({ deliveryMs: 160, replyMs: 2200 }));

  // 1. First send from the empty home.
  await type(page, ['把登录模块重构一下', '保留现有的接口', '再补上测试']);
  const home = await recordWhile(page, () => page.keyboard.press('Enter'), 3600);
  const sending = home.findIndex(sample => sample.icon === 'loader-4');
  const titleGone = home.findIndex(sample => !sample.title);
  const copyFrames = home.filter(sample => sample.copies > 0);
  const bottoms = home.map(sample => sample.frame.top + sample.frame.height);
  const heights = home.map(sample => sample.frame.height);
  const docked = bottoms.findIndex(bottom => Math.abs(bottom - bottoms.at(-1)) < 1);
  if (verbose) {
    console.log('frame top/height:', describe(home));
    console.log('copies:', copyFrames.map(sample => `${sample.copies}:${sample.copyOpacity.toFixed(2)}`).join(' '));
  }
  assert(sending >= 0 && titleGone >= 0 && titleGone <= sending + 1, `the real heading leaves with the send (gone at frame ${titleGone}, sending at ${sending})`, failures);
  assert(copyFrames.length >= 4 && copyFrames.at(-1).copyOpacity < copyFrames[0].copyOpacity && home.at(-1).copies === 0,
    `title and starters fade out as copies over ${copyFrames.length} frames, then are removed`, failures);
  assert(bottoms.at(-1) - bottoms[0] > 120, `the composer docks from the home position to the bottom (${Math.round(bottoms[0])} → ${Math.round(bottoms.at(-1))})`, failures);
  const distance = bottoms.at(-1) - bottoms[0];
  assert(docked > 12 && largestStep(bottoms) < distance * 0.25, `docking takes ${docked} frames without a jump (largest step ${Math.round(largestStep(bottoms))}px of ${Math.round(distance)})`, failures);
  // The clear, the delivery row as the run starts and leaves, and the hint row all glide.
  assert(largestStep(heights) < 10, `the composer height changes without a step (largest ${largestStep(heights).toFixed(1)}px; ${Math.round(heights[0])} → ${Math.round(Math.max(...heights))} → ${Math.round(heights.at(-1))})`, failures);
  const icons = home.map(sample => sample.icon).filter((icon, index, all) => icon && icon !== all[index - 1]);
  assert(icons.join(' > ') === 'loader-4 > stop > arrow-up', `the button swaps spinner → stop → arrow (${icons.join(' > ')})`, failures);
  assert(home.some(sample => sample.leavingIcons > 0), 'the previous icon leaves in the same cell', failures);
  const first = flight(home);
  if (verbose && first.flying.length) {
    console.log('flight:', first.flying.map(sample => `${Math.round(sample.overlay.left)},${Math.round(sample.overlay.top)} ${Math.round(sample.overlay.width)}x${Math.round(sample.overlay.height)} → ${Math.round(sample.bubble.left)},${Math.round(sample.bubble.top)} ${Math.round(sample.bubble.width)}x${Math.round(sample.bubble.height)}`).join(' | '));
  }
  assert(first.flying.length >= 12, `the message flies for ${first.flying.length} frames`, failures);
  assert(first.gap < 1.5 && first.after && first.after.bubble?.opacity !== '0',
    `it lands on the live bubble (last gap ${first.gap.toFixed(2)}px) and the bubble takes over the next frame`, failures);
  assert(first.arc >= 3, `x leads y in ${first.arc} frames: a shallow arc`, failures);
  // The bubble folds to its two-line preview after it mounts; the flight eases into that.
  // The ease is time-based, so a long frame takes a bigger share; a snap takes all of it at once.
  const fold = Math.abs(first.flying[0].bubble.height - first.flying.at(-1).bubble.height);
  const sizeStep = largestStep(first.flying.map(sample => sample.overlay.height));
  assert(fold < 2 || sizeStep < fold * 0.75, `the flight eases into the bubble's ${Math.round(fold)}px fold (largest step ${sizeStep.toFixed(1)}px)`, failures);

  // 2. A follow-up from the docked composer, while the turn travels to the top.
  await page.waitForFunction(() => !window.__send.busy(), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  await type(page, ['继续：把刷新令牌也处理掉']);
  const follow = await recordWhile(page, () => page.keyboard.press('Enter'), 1600);
  const second = flight(follow);
  const bubbleTops = second.flying.map(sample => sample.bubble.top);
  assert(second.flying.length >= 10, `a follow-up flies for ${second.flying.length} frames`, failures);
  // The sampler can run before the flight within a frame while the turn is still moving.
  assert(second.gap < 2, `it lands on the bubble (gap ${second.gap.toFixed(2)}px)`, failures);
  assert(bubbleTops.length > 2 && bubbleTops[0] - bubbleTops.at(-1) > 40, `the destination moved ${Math.round((bubbleTops[0] ?? 0) - (bubbleTops.at(-1) ?? 0))}px during the flight and was followed`, failures);

  // 3. Clearing a long draft glides the composer down; deleting a line does not.
  await page.waitForFunction(() => !window.__send.busy(), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  await type(page, ['一', '二', '三', '四']);
  const line = await recordWhile(page, () => page.keyboard.press('Backspace').then(() => page.keyboard.press('Backspace')), 400);
  assert(!line.some(sample => sample.frame.gliding), 'removing a line while text remains is immediate', failures);
  const clear = await recordWhile(page, async () => { await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); }, 900);
  const gliding = clear.filter(sample => sample.frame.gliding);
  const clearHeights = clear.map(sample => sample.frame.height);
  if (verbose) console.log('clear:', describe(clear));
  const drop = clearHeights[0] - Math.min(...clearHeights);
  assert(drop > 15 && gliding.length >= 8 && largestStep(clearHeights) < drop * 0.5,
    `the cleared composer glides down ${Math.round(drop)}px over ${gliding.length} frames (largest step ${Math.round(largestStep(clearHeights))}px)`, failures);
  assert(!clear.at(-1).frame.gliding, 'the glide releases the frame when it arrives', failures);

  // 4. Reduced motion: no flight and no glide.
  await page.evaluate(() => window.__send.setMotion('reduced'));
  await page.waitForTimeout(200);
  await type(page, ['第一行', '第二行', '第三行']);
  const quiet = await recordWhile(page, () => page.keyboard.press('Enter'), 900);
  assert(!quiet.some(sample => sample.overlay) && !quiet.some(sample => sample.frame.gliding),
    `reduced motion: no flight (${quiet.filter(sample => sample.overlay).length} frames) and no glide (${quiet.filter(sample => sample.frame.gliding).length})`, failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
