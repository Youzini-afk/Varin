// Streaming text: frame-paced reveal, ink front, end dot, drain and cleanup.
const { openLab, assert } = require('./lab.cjs');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab();

  // 1. Rich Markdown at a fast but realistic rate, chunked by the network.
  await page.evaluate(() => window.__lab.record());
  const streaming = page.evaluate(() => window.__lab.stream({ chars: 1400, cps: 150, interval: 100, rich: true, pauseAt: 700, pauseMs: 1400 }));
  await streaming;
  const endedAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(700);
  const frames = await page.evaluate(() => window.__lab.stopRecording());
  const live = frames.filter((frame) => frame.t < endedAt);
  const steps = live.slice(1).map((frame, index) => frame.shown - live[index].shown).filter((step) => step !== 0);
  const growth = steps.filter((step) => step > 0);
  const maxStep = Math.max(...growth);
  // Rendered text can also jump when a block's decoration changes (a fence
  // closing gains its line numbers); those are rare single frames.
  const bigSteps = growth.filter((step) => step > 24).length;
  const inkFrames = live.filter((frame) => frame.ink > 0).length;
  const caretFrames = live.filter((frame) => frame.caret).length;
  const waiting = live.some((frame) => frame.caret === 'waiting');
  const after = frames.filter((frame) => frame.t >= endedAt);
  const drained = after.find((frame) => frame.caret === null && frame.ink === 0);
  console.log(JSON.stringify({ liveFrames: live.length, growthFrames: growth.length, maxStep, inkFrames, caretFrames, waiting, drainedAfterMs: drained ? Math.round(drained.t - endedAt) : null, final: after.at(-1) }));
  if (process.env.LAB_VERBOSE) {
    live.forEach((frame, index) => {
      const step = index ? frame.shown - live[index - 1].shown : 0;
      if (step > 20 || (frame.caret && !frame.caretLast)) console.log(`${Math.round(frame.t)} dt=${index ? Math.round(frame.t - live[index - 1].t) : 0} shown=${frame.shown} step=${step} caret=${frame.caret} last=${frame.caretLast} where=${frame.caretWhere}`);
    });
  }
  assert(growth.length > live.length * 0.5, `text grows on most frames, not per network chunk (${growth.length}/${live.length})`, failures);
  assert(bigSteps <= 3, `reveal steps stay small (${bigSteps} frames over 24 chars, largest ${maxStep})`, failures);
  assert(inkFrames > live.length * 0.5, `ink is developing on most streaming frames (${inkFrames}/${live.length})`, failures);
  assert(caretFrames > live.length * 0.8, `the end dot is present while streaming (${caretFrames}/${live.length})`, failures);
  assert(live.filter((frame) => frame.caret).every((frame) => frame.caretLast), 'the end dot always sits right after the last text', failures);
  assert(waiting, 'the dot breathes while the stream pauses', failures);
  assert(Boolean(drained) && drained.t - endedAt < 600, `after the end the backlog drains and the dot leaves (${drained ? Math.round(drained.t - endedAt) : '-'}ms)`, failures);

  // 2. The final DOM is the plain rendered answer: no ink, no dot, highlighted code.
  const finalState = await page.evaluate(() => {
    const markdown = [...document.querySelectorAll('[data-markdown-content]')].at(-1);
    return {
      ink: markdown.querySelectorAll('.markdown-ink, .markdown-caret').length,
      text: markdown.textContent.length,
      code: markdown.querySelectorAll('pre code [class*="hl"], pre code span').length,
    };
  });
  console.log(JSON.stringify(finalState));
  assert(finalState.ink === 0, 'no ink or dot nodes remain', failures);
  assert(finalState.code > 0, 'the finished code block is highlighted', failures);

  // 3. Motion off: paced, but without ink or the dot.
  await page.evaluate(() => window.__lab.setMotion('off'));
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.stream({ chars: 500, cps: 150, interval: 100, rich: true }));
  const offFrames = await page.evaluate(() => window.__lab.stopRecording());
  const offGrowth = offFrames.slice(1).filter((frame, index) => frame.shown > offFrames[index].shown).length;
  assert(offFrames.every((frame) => frame.ink === 0 && frame.caret === null), 'off: no ink and no dot', failures);
  assert(offGrowth > offFrames.length * 0.4, `off: still paced per frame (${offGrowth}/${offFrames.length})`, failures);

  assert(errors.filter((error) => !error.includes('404')).length === 0, `no page errors ${JSON.stringify(errors.filter((error) => !error.includes('404')))}`, failures);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall stream checks passed');
  process.exit(failures.length ? 1 : 0);
})();
