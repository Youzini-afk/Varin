/* Embedded verbatim in both desktop shells. Fixed, data-only replay and passive
 * numeric observations of the REAL document. No styles, stores, API substitutes,
 * forced GC, frame throttling, response bodies, or arbitrary expressions. */
(() => {
  if (window.__varinDesktopBenchmark) return;
  let workload, index = 0, stepStarted = 0, dispatched = false, committed = null;
  let readyAt = null, startedAt = performance.now(), status = 'waiting-ready', error = null;
  let pendingAction = null, previousFrame = null, frames = [], events = [], receipts = [];
  let trustedInputs = 0, stepInputBaseline = 0, scrollBefore = null, framesObserved = 0, externalInputs = 0, externalBaseline = 0;
  let observer = null, raf = null, stopped = false;
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const find = selector => document.querySelector(selector);
  const match = test => {
    const elements = document.querySelectorAll(test.selector), element = elements[0];
    if (test.textIncludes !== undefined && !element?.textContent?.includes(test.textIncludes)) return false;
    if (test.focused !== undefined && (element === document.activeElement || element?.contains(document.activeElement)) !== test.focused) return false;
    if (test.count !== undefined && elements.length !== test.count) return false;
    if (test.visible !== undefined && visible(element) !== test.visible) return false;
    if (test.attribute !== undefined && element?.getAttribute(test.attribute) !== test.equals) return false;
    if (test.minTextLength !== undefined && (element?.textContent?.length ?? 0) < test.minTextLength) return false;
    return test.count === 0 || test.visible === false || !!element;
  };
  const matches = tests => (tests ?? []).every(match);
  const fail = reason => { status = 'failed'; error = reason; pendingAction = null; };
  const input = event => { if (event.isTrusted) trustedInputs++; };
  const frame = now => {
    if (previousFrame !== null && document.visibilityState === 'visible') { frames.push(now - previousFrame); framesObserved++; }
    previousFrame = now;
    if (frames.length > 20000) { fail('Renderer sampler was not drained; frame observations overflowed'); frames = frames.slice(-20000); }
    if (!stopped) raf = requestAnimationFrame(frame);
  };
  const finishStep = now => {
    const step = workload.steps[index];
    receipts.push({ id: step.id, action: step.action, cycle: step.cycle ?? null, milestone: step.milestone ?? null,
      startedMs: stepStarted, committedMs: committed ?? now, settledMs: now, trustedInputs: trustedInputs - stepInputBaseline,
      ...(step.action === 'manual' ? { externalTrustedInputs: externalInputs - externalBaseline, nativeCoverage: 'operator-observation-still-required' } : {}) });
    index++; stepStarted = now; dispatched = false; committed = null; pendingAction = null; scrollBefore = null; stepInputBaseline = trustedInputs; externalBaseline = externalInputs;
    if (index >= workload.steps.length) status = 'completed';
  };
  const advance = now => {
    if (!workload || ['failed', 'completed'].includes(status) || workload.passive) return;
    if (status === 'running' && now - readyAt > workload.timeoutMs) return fail('Workload observation deadline ended before a terminal receipt');
    if (status === 'waiting-ready') {
      if (window.__VARIN_RUNTIME_APIS__ && window.__VARIN_DESKTOP__ && document.readyState === 'complete'
        && visible(find('[data-varin-workbench-switcher]')) && matches(workload.ready)) {
        if (document.documentElement.dataset.motion !== 'full' || matchMedia('(prefers-reduced-motion: reduce)').matches) return fail('Full product motion is not enabled; the benchmark will not override it');
        status = 'running'; readyAt = now; frames = []; events = []; previousFrame = null; stepStarted = now; stepInputBaseline = trustedInputs; externalBaseline = externalInputs;
      } else if (now - startedAt > workload.readyTimeoutMs) fail('The real authoritative Varin workbench did not become ready');
      return;
    }
    if (document.documentElement.dataset.motion !== 'full' || matchMedia('(prefers-reduced-motion: reduce)').matches) return fail('Full product motion changed during measurement');
    const step = workload.steps[index];
    if (now - stepStarted > (step.timeoutMs ?? workload.timeoutMs)) return fail(`Replay action ${step.id} did not produce its actual commit`);
    if (step.action === 'wait') { if (now - stepStarted >= step.durationMs && matches(step.expect)) finishStep(now); return; }
    if (step.action === 'checkpoint') { if (now - stepStarted >= (step.settleMs ?? 1000) && matches(step.expect)) finishStep(now); return; }
    if (step.action === 'manual') {
      if (now - stepStarted >= step.durationMs && (trustedInputs > stepInputBaseline || externalInputs > externalBaseline) && matches(step.expect)) finishStep(now);
      return;
    }
    if (!dispatched && !pendingAction) {
      const element = step.selector ? find(step.selector) : document.activeElement;
      if (!visible(element) || element?.disabled || element?.getAttribute('aria-disabled') === 'true') return;
      if (step.action !== 'scroll' && !step.expect?.some(test => test.focused === true) && matches(step.expect)) return fail(`Replay action ${step.id} postcondition already held before input`);
      const bounds = element.getBoundingClientRect(), x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return fail(`Replay target ${step.id} is outside the actual viewport`);
      if (step.action === 'scroll') scrollBefore = element.scrollTop;
      pendingAction = { id: step.id, action: step.action, x, y,
        ...(step.key ? { key: step.key, modifiers: step.modifiers ?? 0 } : {}),
        ...(step.text ? { text: step.text } : {}),
        ...(step.action === 'scroll' ? { deltaX: step.deltaX ?? 0, deltaY: step.deltaY } : {}) };
      return;
    }
    if (!dispatched) return;
    const changed = step.action !== 'scroll' || find(step.selector)?.scrollTop !== scrollBefore;
    if (changed && matches(step.expect) && trustedInputs > stepInputBaseline) {
      committed ??= now;
      // Do not cancel or accelerate animations, including continuous companion animations.
      if (now - committed >= (step.settleMs ?? 0)) finishStep(now);
    }
  };
  window.__varinDesktopBenchmark = {
    start(value) {
      if (workload) throw new Error('Benchmark observer is already installed');
      workload = value; startedAt = performance.now();
      if (value.passive) { status = 'observing'; readyAt = startedAt; }
      for (const name of ['pointerdown', 'keydown', 'input', 'wheel']) document.addEventListener(name, input, { capture: true, passive: true });
      if (PerformanceObserver.supportedEntryTypes?.includes('event')) {
        observer = new PerformanceObserver(list => {
          for (const event of list.getEntries()) events.push({ entryType: event.entryType, startTime: event.startTime, duration: event.duration,
            inputDelayMs: event.processingStart - event.startTime, processingMs: event.processingEnd - event.processingStart, interactionId: event.interactionId });
          if (events.length > 20000) { fail('Input observation overflow'); events = events.slice(-20000); }
        });
        observer.observe({ type: 'event', buffered: false, durationThreshold: 16 });
        if (PerformanceObserver.supportedEntryTypes.includes('first-input')) observer.observe({ type: 'first-input', buffered: false });
      }
      raf = requestAnimationFrame(frame);
      return { installed: true, frameTiming: 'visible-document-requestAnimationFrame', inputTiming: 'PerformanceEventTiming-durationThreshold-16ms-plus-first-input; quantized-event-duration-not-INP', eventTimingAvailable: !!observer };
    },
    externalInputs(total) { if (!Number.isSafeInteger(total) || total < externalInputs) throw new Error('Invalid external input counter'); externalInputs = total; return true; },
    dispatched(id) {
      if (pendingAction?.id !== id) throw new Error('Replay input identity mismatch');
      pendingAction = null; dispatched = true;
      return true;
    },
    poll() {
      const now = performance.now();
      try { advance(now); } catch { fail('A fixed DOM observation failed'); }
      const output = { status, error, readyAt, monotonicMs: now, visibility: document.visibilityState, motion: document.documentElement.dataset.motion ?? null,
        viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio }, trustedInputs, frameTimesMs: frames,
        inputLatenciesMs: events.filter(event => event.interactionId > 0).map(event => event.duration), inputEvents: events,
        receipts, stepIndex: index, pendingAction, framesObserved, eventTimingAvailable: !!observer };
      frames = []; events = []; receipts = [];
      return output;
    },
    stop() {
      stopped = true; cancelAnimationFrame(raf); observer?.disconnect();
      for (const name of ['pointerdown', 'keydown', 'input', 'wheel']) document.removeEventListener(name, input, true);
      return true;
    },
  };
})();
