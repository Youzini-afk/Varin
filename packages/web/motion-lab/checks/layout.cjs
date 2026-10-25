// Height changes inside the virtual list: while a process row opens and closes,
// does the row below move in the same frame (no overlap, no gap jumps)?
// This is the LegendList validation the design asks for (§3.8), growing and shrinking.
const { openLab, assert } = require('./lab.cjs');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab();
  await page.evaluate(() => window.__lab.process());
  await page.waitForTimeout(900);
  const sample = () => page.evaluate(() => new Promise((resolve) => {
    const frames = [];
    const heading = [...document.querySelectorAll('.dialogue-activity-heading')].at(-1);
    const block = heading.closest('.conversation-block');
    const start = performance.now();
    // Measure what was painted: after the frame's layout, resize observers
    // and paint, in the task that follows (rAF time precedes the list's own
    // position update in the same frame).
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const blocks = [...document.querySelectorAll('[data-conversation-timeline="true"] .conversation-block')]
        .map((node) => ({ node, rect: node.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top);
      const index = blocks.findIndex((entry) => entry.node === block);
      const own = blocks[index]?.rect;
      const next = blocks[index + 1]?.rect;
      if (own && next) frames.push({ t: performance.now() - start, height: own.height, gap: next.top - own.bottom });
      if (performance.now() - start < 900) requestAnimationFrame(step); else resolve(frames);
    };
    const step = () => channel.port2.postMessage(0);
    heading.click();
    requestAnimationFrame(step);
  }));
  const report = (label, frames) => {
    const gaps = frames.map((frame) => frame.gap);
    const base = gaps.at(-1);
    const off = gaps.filter((gap) => Math.abs(gap - base) > 1.5).length;
    const heights = frames.map((frame) => frame.height);
    const moving = heights.slice(1).filter((height, index) => Math.abs(height - heights[index]) > 0.5).length;
    console.log(JSON.stringify({ label, frames: frames.length, moving, heightFrom: Math.round(heights[0]), heightTo: Math.round(heights.at(-1)), gapMin: Math.min(...gaps).toFixed(1), gapMax: Math.max(...gaps).toFixed(1), gapOff: off }));
    assert(moving >= 4, `${label}: the height animates over several frames (${moving})`, failures);
    assert(Math.min(...gaps) >= base - 1.5, `${label}: rows never overlap (smallest gap ${Math.min(...gaps).toFixed(1)}px)`, failures);
    // Shrinking used to trail by a frame: LegendList defers a smaller size outside its anchoring mode
    // unless the list opts out (`data-legend-immediate-shrink`, bun-patches).
    assert(off <= 1, `${label}: the row below follows in the same painted frame (${off} frames off, largest gap ${(Math.max(...gaps) - base).toFixed(1)}px)`, failures);
  };
  report('open', await sample());
  report('close', await sample());
  assert(errors.filter((error) => !error.includes('404')).length === 0, `no page errors ${JSON.stringify(errors.filter((error) => !error.includes('404')))}`, failures);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall layout checks passed');
  process.exit(failures.length ? 1 : 0);
})();
