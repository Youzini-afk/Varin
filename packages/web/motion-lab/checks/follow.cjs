// Follow scroll: spring following during a stream, release on wheel, return
// to latest, and the reduced-motion fallback. Run with the lab dev server up.
const { openLab, assert } = require('./lab.cjs');

const deltas = (frames) => frames.slice(1).map((frame, index) => frame.scrollTop - frames[index].scrollTop);

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab();

  // 1. Following: a fast CJK stream (160 chars/s) with a pasted-block burst
  // every 2.4s, arriving in network-sized chunks.
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.stream({ chars: 2600, cps: 160, interval: 48, burstEvery: 50, burst: 420 }));
  await page.waitForTimeout(900);
  let frames = await page.evaluate(() => window.__lab.stopRecording());
  let moves = deltas(frames);
  const moving = moves.filter((delta) => Math.abs(delta) > 0.25);
  const maxStep = Math.max(...moves);
  // Headless frames are ~34ms; judge speed rather than a per-frame step.
  // Over two frames: the sampler and the spring run in separate frame
  // callbacks, so one sample interval can be a few milliseconds.
  const speeds = frames.slice(2).map((frame, index) => (frame.scrollTop - frames[index].scrollTop) / Math.max(1, frame.t - frames[index].t) * 1000);
  const maxSpeed = Math.max(...speeds);
  if (process.env.LAB_VERBOSE) {
    const at = speeds.indexOf(maxSpeed);
    console.log(frames.slice(Math.max(0, at - 4), at + 5).map((frame) => `${frame.t.toFixed(1)} top=${frame.scrollTop} gap=${frame.endGap.toFixed(0)} shown=${frame.shown}`).join('\n'));
  }
  // A burst lands below the fold and glides into view; it must not stay there.
  let hiddenSince = null;
  let longestHidden = 0;
  let longestAt = 0;
  frames.forEach((frame, index) => {
    if (frame.endGap > 24) hiddenSince ??= index;
    else hiddenSince = null;
    if (hiddenSince !== null && frame.t - frames[hiddenSince].t > longestHidden) {
      longestHidden = frame.t - frames[hiddenSince].t;
      longestAt = hiddenSince;
    }
  });
  if (process.env.LAB_VERBOSE) {
    console.log(frames.slice(Math.max(0, longestAt - 2), longestAt + 34)
      .map((frame) => `${frame.t.toFixed(0)} top=${frame.scrollTop.toFixed(1)} gap=${frame.endGap.toFixed(1)}`).join('\n'));
  }
  const finalGap = frames.at(-1).endGap;
  // Before the reply reaches the fold the list may settle its own layout;
  // only the following itself has to be monotonic.
  const firstFollow = moves.findIndex((delta) => delta > 0.25);
  const followMoves = moves.slice(Math.max(0, firstFollow));
  const backwards = Math.min(...followMoves);
  const backIndex = firstFollow + followMoves.indexOf(backwards);
  console.log(JSON.stringify({ frames: frames.length, movingFrames: moving.length, maxStep, backwards, longestHidden, finalGap }));
  if (backwards <= -1) console.log('around backwards step', JSON.stringify(frames.slice(Math.max(0, backIndex - 3), backIndex + 4)));
  assert(frames.every((frame) => frame.mode === 'following-end'), 'stays in following-end while streaming', failures);
  // A placed jump of a block or two in one frame reads as >3000px/s.
  assert(maxSpeed < 2500, `following never jumps (peak ${maxSpeed.toFixed(0)}px/s, largest frame ${maxStep.toFixed(0)}px)`, failures);
  assert(backwards > -1, `never scrolls backwards while following (${backwards.toFixed(2)}px)`, failures);
  assert(moving.length > 20, `scroll moves across many frames, not in single jumps (${moving.length})`, failures);
  // The spring trails a fast reveal by about 2v/ω; it must stay bounded and
  // catch up as soon as the reveal slows down.
  const maxGap = Math.max(...frames.map((frame) => frame.endGap));
  console.log(JSON.stringify({ maxGap, longestHiddenMs: Math.round(longestHidden) }));
  assert(maxGap <= 180, `lag behind the live end stays bounded (${maxGap.toFixed(0)}px <= 180px)`, failures);
  assert(longestHidden <= 700, `the end is back in view within 700ms of a burst (${longestHidden.toFixed(0)}ms)`, failures);
  assert(finalGap < 0 && finalGap > -140, `settles at the reading gap (${finalGap.toFixed(1)}px)`, failures);

  // 2. Release: a wheel up during a stream hands scrolling to the reader.
  const streaming = page.evaluate(() => window.__lab.stream({ chars: 2400, cps: 160, interval: 48 }));
  await page.waitForTimeout(500);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(300);
  const released = await page.evaluate(() => ({ view: window.__lab.view(), metrics: window.__lab.metrics() }));
  await page.waitForTimeout(700);
  const later = await page.evaluate(() => window.__lab.metrics());
  const pill = await page.$('[data-conversation-return-latest]');
  assert(released.view?.scrollMode === 'free-scrolling', 'wheel up releases following', failures);
  assert(Math.abs(later.scrollTop - released.metrics.scrollTop) < 2, `reading position holds while content grows (${(later.scrollTop - released.metrics.scrollTop).toFixed(1)}px)`, failures);
  assert(Boolean(pill), 'return-to-latest pill appears', failures);

  // 3. Return: the pill travels back and following resumes.
  await page.evaluate(() => window.__lab.record());
  await pill?.click();
  await page.waitForTimeout(1300);
  frames = await page.evaluate(() => window.__lab.stopRecording());
  moves = deltas(frames);
  const returnSteps = moves.filter((delta) => delta > 0.25);
  const view = await page.evaluate(() => window.__lab.view());
  console.log(JSON.stringify({ returnFrames: returnSteps.length, maxReturnStep: Math.max(...moves), endGap: frames.at(-1).endGap }));
  assert(view?.scrollMode === 'following-end', 'returning resumes following', failures);
  assert(returnSteps.length >= 8, `return travels over several frames (${returnSteps.length})`, failures);
  assert(frames.at(-1).endGap < 24, `return ends at the live edge (${frames.at(-1).endGap.toFixed(1)}px)`, failures);
  assert(!frames.at(-1).pill, 'pill leaves after returning', failures);
  await streaming;

  // 4. Anchoring: a sent turn sits at the top while its reply grows beneath
  // it; once the reply passes the comfortable line, the turn is followed.
  const entryId = await page.evaluate(() => window.__lab.send(undefined, { track: true }));
  await page.waitForTimeout(900);
  const anchoredTop = await page.evaluate((id) => window.__lab.entryTop(id), entryId);
  frames = await page.evaluate(() => window.__lab.stopRecording());
  moves = deltas(frames);
  const travel = moves.filter((delta) => Math.abs(delta) > 0.25);
  // Judge what the reader sees: the turn itself only moves up. (The list may
  // compensate the scroll for rows above settling; that is not movement.)
  const tops = frames.map((frame) => frame.turnTop).filter((top) => top !== null);
  const turnBack = Math.max(0, ...tops.slice(1).map((top, index) => top - tops[index]));
  console.log(JSON.stringify({ anchoredTop, travelFrames: travel.length, maxTravelStep: Math.max(...moves), turnBack }));
  assert(anchoredTop !== null && anchoredTop >= 0 && anchoredTop < 64, `sent turn anchors near the top (${anchoredTop})`, failures);
  assert(travel.length >= 8 && turnBack <= 2, `sent turn travels to the top over ${travel.length} frames without moving back (${turnBack}px)`, failures);
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.stream({ chars: 1800, cps: 160, interval: 48, burstEvery: 30, burst: 300 }));
  await page.waitForTimeout(800);
  frames = await page.evaluate(() => window.__lab.stopRecording());
  moves = deltas(frames);
  const anchorMoves = moves.filter((delta) => Math.abs(delta) > 0.25);
  const anchorGap = Math.max(...frames.map((frame) => frame.endGap));
  console.log(JSON.stringify({ modes: [...new Set(frames.map((frame) => frame.mode))], anchorMoves: anchorMoves.length, maxAnchorStep: Math.max(...moves), minAnchorStep: Math.min(...moves), anchorGap, final: frames.at(-1).endGap }));
  assert(frames.at(-1).mode === 'following-end', 'past the comfortable line the sent turn hands over to following', failures);
  assert(Math.max(...moves) < 40, `anchored follow moves in small steps (${Math.max(...moves).toFixed(1)}px)`, failures);
  assert(Math.min(...moves) > -1, `anchored follow never scrolls backwards (${Math.min(...moves).toFixed(1)}px)`, failures);
  assert(anchorMoves.length > 20, `anchored follow is continuous (${anchorMoves.length} moving frames)`, failures);
  assert(frames.at(-1).endGap < 24, `anchored reply ends in view (${frames.at(-1).endGap.toFixed(1)}px)`, failures);

  // 5. Reduced motion: follow places the end directly.
  await page.evaluate(() => window.__lab.setMotion('reduced'));
  await page.evaluate(() => window.__lab.enter());
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__lab.record());
  await page.evaluate(() => window.__lab.stream({ chars: 900, cps: 140, interval: 48, burstEvery: 6, burst: 420 }));
  await page.waitForTimeout(300);
  frames = await page.evaluate(() => window.__lab.stopRecording());
  let reducedRun = 0;
  let reducedLongest = 0;
  for (const frame of frames) {
    reducedRun = frame.endGap > 24 ? reducedRun + 1 : 0;
    reducedLongest = Math.max(reducedLongest, reducedRun);
  }
  assert(frames.every((frame) => frame.mode === 'following-end'), 'reduced: stays following', failures);
  // Growth is placed in the next frame; the sampler may run before that frame's
  // follow callback, so it can see one extra frame.
  assert(reducedLongest <= 2, `reduced: growth is placed by the next frame (longest ${reducedLongest} sampled frames below the edge)`, failures);

  assert(errors.filter((error) => !error.includes('404')).length === 0, `no page errors ${JSON.stringify(errors.filter((error) => !error.includes('404')))}`, failures);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall follow checks passed');
  process.exit(failures.length ? 1 : 0);
})();
