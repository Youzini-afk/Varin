/* Embedded verbatim in both desktop shells. Fixed, data-only replay and passive
 * numeric observations of the REAL document. No styles, stores, API substitutes,
 * forced GC, frame throttling, response bodies, or arbitrary expressions. */
(() => {
  if (window.__varinDesktopBenchmark) return;
  let workload, workloadIdentity, index = 0, stepStarted = 0, dispatched = false, committed = null;
  let readyAt = null, startedAt = performance.now(), status = 'waiting-ready', error = null;
  let pendingAction = null, previousFrame = null, frames = [], events = [], receipts = [];
  let trustedInputs = 0, stepInputBaseline = 0, scrollBefore = null, framesObserved = 0, externalInputs = 0, externalBaseline = 0;
  let ownerObservation = null, nativeBrowserComplete = false, remoteComplete = false, companionComplete = false, companionClosed = false, lastRunId = null;
  const observedProcesses = new Map();
  let observer = null, raf = null, stopped = false;
  const visible = element => !!element && !element.closest?.('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const find = selector => document.querySelector(selector);
  const match = test => {
    const elements = document.querySelectorAll(test.selector), element = elements[0];
    if (test.textEquals !== undefined && element?.textContent !== test.textEquals) return false;
    if (test.fileCount !== undefined && element?.files?.length !== test.fileCount) return false;
    if (test.value !== undefined && element?.value !== test.value) return false;
    if (test.textIncludes !== undefined && !element?.textContent?.includes(test.textIncludes)) return false;
    if (test.focused !== undefined && (element === document.activeElement || element?.contains(document.activeElement)) !== test.focused) return false;
    if (test.count !== undefined && elements.length !== test.count) return false;
    if (test.visible !== undefined && visible(element) !== test.visible) return false;
    if (test.attribute !== undefined && element?.getAttribute(test.attribute) !== test.equals) return false;
    if (test.minTextLength !== undefined && (element?.textContent?.length ?? 0) < test.minTextLength) return false;
    return test.count === 0 || test.visible === false || !!element;
  };
  const matches = tests => (tests ?? []).every(match);
  const ownerMatches = expected => {
    if (!expected) return true;
    if (expected === 'companion-closed') return companionClosed;
    if (expected === 'companion-completed') return companionComplete;
    if (expected === 'remote-completed') return remoteComplete;
    if (!ownerObservation || ownerObservation.error) return false;
    if (expected === 'browser-page-opened') return typeof ownerObservation.pageId === 'string';
    if (expected === 'browser-download-completed') return nativeBrowserComplete && ownerObservation.download?.state === 'completed' && ownerObservation.download.sha256 === workload.browser.downloadSha256;
    const rows = [...observedProcesses.values()];
    if (expected === 'process-running') return rows.some(row => row.writerActive === true && row.status === 'running');
    if (expected === 'process-completed') return rows.some(row => row.writerActive === false && row.status === 'exited' && row.exitCode === 0);
    if (expected === 'process-stopped') return rows.filter(row => row.wasRunning).length >= 2 && rows.every(row => row.writerActive === false && ['exited', 'released'].includes(row.status))
      && ownerObservation.operations.some(row => row.phase === 'terminal' && row.outcome === 'cancelled');
    return ownerObservation.run?.state === (expected === 'run-cancelled' ? 'cancelled' : 'completed');
  };
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
      if (document.readyState === 'complete' && matches(workload.ready) && (workload.surface === 'fixture-browser'
        ? location.href === workload.url && !!find('body[data-varin-browser-fixture]')
        : window.__VARIN_RUNTIME_APIS__ && window.__VARIN_DESKTOP__ && visible(find('[data-varin-workbench-switcher]')))) {
        if (workload.surface !== 'fixture-browser' && (document.documentElement.dataset.motion !== 'full' || matchMedia('(prefers-reduced-motion: reduce)').matches)) return fail('Full product motion is not enabled; the benchmark will not override it');
        status = 'running'; readyAt = now; frames = []; events = []; previousFrame = null; stepStarted = now; stepInputBaseline = trustedInputs; externalBaseline = externalInputs;
      } else if (now - startedAt > workload.readyTimeoutMs) fail('The real authoritative Varin workbench did not become ready');
      return;
    }
    if (workload.surface !== 'fixture-browser' && (document.documentElement.dataset.motion !== 'full' || matchMedia('(prefers-reduced-motion: reduce)').matches)) return fail('Full product motion changed during measurement');
    const step = workload.steps[index];
    if (now - stepStarted > (step.timeoutMs ?? workload.timeoutMs)) return fail(`Replay action ${step.id} did not produce its actual commit`);
    if (step.action === 'wait') { if (now - stepStarted >= step.durationMs && matches(step.expect) && ownerMatches(step.owner)) finishStep(now); return; }
    if (step.action === 'checkpoint') { if (now - stepStarted >= (step.settleMs ?? 1000) && matches(step.expect)) finishStep(now); return; }
    if (step.action === 'manual') {
      if (now - stepStarted >= step.durationMs && (trustedInputs > stepInputBaseline || externalInputs > externalBaseline) && matches(step.expect)) finishStep(now);
      return;
    }
    if (!dispatched && !pendingAction) {
      const element = step.selector ? find(step.selector) : document.activeElement;
      if (step.optional && !visible(element)) { if (now - stepStarted >= (step.durationMs ?? 10000) && matches(step.expect) && ownerMatches(step.owner)) finishStep(now); return; }
      if (!visible(element) || element?.disabled || element?.getAttribute('aria-disabled') === 'true') return;
      if (step.action !== 'scroll' && !step.expect?.some(test => test.focused === true) && matches(step.expect) && ownerMatches(step.owner)) return fail(`Replay action ${step.id} postcondition already held before input`);
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
    if (changed && matches(step.expect) && ownerMatches(step.owner) && (step.action === 'file' || trustedInputs > stepInputBaseline)) {
      committed ??= now;
      // Do not cancel or accelerate animations, including continuous companion animations.
      if (now - committed >= (step.settleMs ?? 0)) finishStep(now);
    }
  };
  window.__varinDesktopBenchmark = {
    start(value) {
      if (workload) {
        if (stopped || workloadIdentity !== JSON.stringify(value)) throw new Error('Benchmark observer workload changed or ended');
        return { installed: true, resumed: true }; // Never reset progress or replay effects.
      }
      workloadIdentity = JSON.stringify(value);
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
    matchesWorkload(value) { return !stopped && workloadIdentity === JSON.stringify(value); },
    companionClosed(value) { if (typeof value !== 'boolean') throw new Error('Invalid companion closed state'); companionClosed = value; return true; },
    companionCompletion(value) { if (typeof value !== 'boolean') throw new Error('Invalid companion completion'); companionComplete = value; return true; },
    remoteCompletion(value) { if (typeof value !== 'boolean') throw new Error('Invalid remote completion'); remoteComplete = value; return true; },
    nativeCompletion(value) { if (typeof value !== 'boolean') throw new Error('Invalid native completion'); nativeBrowserComplete = value; return true; },
    async observeOwner() {
      if (!workload?.ownerIdentity && !workload?.browser) return true;
      try {
        const base = new URL(window.__VARIN_API_BASE_URL__ || window.__VARIN_LOCAL_ORIGIN__);
        if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Expected this run’s isolated loopback Host');
        if (workload.browser) {
          const read = async route => {
            const response = await fetch(new URL(route, base), { headers: { authorization: `Bearer ${window.__VARIN_CLIENT_TOKEN__}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
            if (!response.ok) throw new Error('Original Browser owner read failed'); return response;
          };
          const catalog = await (await read('/api/browsers')).json();
          const pages = catalog.pages.filter(page => page.url === workload.browser.url);
          if (pages.length !== 1) { ownerObservation = { error: 'Expected exactly one original native fixture page' }; return true; }
          const page = pages[0], prefix = `/api/browsers/pages/${encodeURIComponent(page.pageId)}/downloads`;
          const downloads = await (await read(prefix)).json();
          const completed = downloads.find(item => item.state === 'completed' && item.name === 'benchmark-download.txt');
          if (!completed) { ownerObservation = { pageId: page.pageId, download: null }; return true; }
          const bytes = await (await read(`${prefix}/${encodeURIComponent(completed.downloadId)}`)).arrayBuffer();
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          ownerObservation = { pageId: page.pageId, download: { downloadId: completed.downloadId, state: completed.state, bytes: bytes.byteLength,
            sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), source: 'original-native-download-owner-completed-file-read' } };
          return true;
        }
        const api = window.__VARIN_RUNTIME_APIS__?.threads;
        if (!api) throw new Error('Original Thread API is unavailable');
        const snapshot = await api.snapshot(workload.ownerIdentity);
        const url = new URL('/api/terminal/processes', base); url.searchParams.set('cwd', workload.workspace);
        const response = await fetch(url, { headers: { authorization: `Bearer ${window.__VARIN_CLIENT_TOKEN__}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) throw new Error('Original process owner is unavailable');
        const result = await response.json();
        for (const process of result.processes ?? []) {
          const key = `${process.processId}:${process.kernelEpoch}`;
          observedProcesses.set(key, { processId: process.processId, kernelEpoch: process.kernelEpoch, pid: process.pid, status: process.status,
            writerActive: process.writerActive, exitCode: process.exitCode, signal: process.signal, outputComplete: process.outputComplete,
            wasRunning: observedProcesses.get(key)?.wasRunning || process.writerActive === true });
        }
        if (snapshot.activeRun?.id) lastRunId = snapshot.activeRun.id;
        const run = snapshot.activeRun ?? (lastRunId ? await api.run(lastRunId) : null);
        ownerObservation = { run: run ? { id: run.id, state: run.state } : null,
          processes: [...observedProcesses.values()], operations: (snapshot.operations ?? []).filter(row => row.managed_process).map(row => ({ id: row.id, phase: row.phase, outcome: row.outcome, cancelRequested: row.cancel_requested })) };
      } catch { ownerObservation = { error: 'Original owner observation unavailable; no terminal outcome inferred' }; }
      return true;
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
        ownerObservation, viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio }, trustedInputs, frameTimesMs: frames,
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

// Opt-in native benchmark diagnostic. It never selects a production action,
// mutates Host state, changes timing, or returns image bytes. Asset coverage is
// deliberately separate from the normal player's real paint observations.
(() => {
  if (window.__varinCompanionBenchmark) return;
  let config, start = null, normalEnd = null, status = 'waiting-ready', drag = null, normal = null, diagnostic = null, stopped = false, pending = null;
  let bitmap = null, surface = null;
  const controller = new AbortController();
  const ensureActive = () => { if (stopped) throw new Error('Diagnostic interrupted'); };
  const readAsset = async url => { ensureActive(); const response = await fetch(url, { signal: controller.signal }); ensureActive(); return response; };
  const observation = () => document.querySelector('canvas')?.__varinCompanionEvidence;
  async function diagnose() {
    status = 'asset-diagnostic';
    const decoded = new Map(), packages = [], failed = [];
    let closedBitmaps = 0;
    try {
      const assetBase = document.querySelector('canvas')?.__varinCompanionAssetBase;
      if (typeof assetBase !== 'string') throw new Error('Original pinned asset reader is unavailable');
      const base = new URL(assetBase, location.href);
      if (!['varin-ui:', 'varin-companion:', 'http:'].includes(base.protocol) || base.protocol === 'http:' && base.hostname !== 'varin-companion.localhost') throw new Error('Diagnostic only reads the original native asset protocol');
      const response = await readAsset(new URL('bundle.json', base));
      if (!response.ok) throw new Error('Installed bundle is unavailable');
      const bytes = await response.arrayBuffer(); ensureActive();
      const epoch = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
      if (epoch !== config.epoch || observation()?.epoch !== epoch) throw new Error('Original installed and painted epochs differ');
      const bundle = JSON.parse(new TextDecoder().decode(bytes));
      if (bundle.packages.length !== config.packageCount) throw new Error('Installed package coverage universe changed');
      for (const item of bundle.packages) {
        if (stopped) throw new Error('Diagnostic interrupted');
        const images = [];
        let drawn = 0;
        try {
          for (const page of item.pages) {
            if (!/^[\w.-]+\.png$/u.test(page.file)) throw new Error('Invalid fixed atlas name');
            const url = new URL(page.file, base); url.searchParams.set('epoch', epoch);
            const source = await readAsset(url); if (!source.ok) throw new Error('Original atlas unavailable');
            const blob = await source.blob(); ensureActive();
            bitmap = await createImageBitmap(blob); images.push(bitmap); bitmap = null; ensureActive();
            const image = images.at(-1); decoded.set(page.file, { file: page.file, width: image.width, height: image.height });
          }
          surface = new OffscreenCanvas(...item.canvas); const context = surface.getContext('2d');
          if (!context) throw new Error('Diagnostic canvas unavailable');
          for (const frame of item.frames) {
            const image = images[frame.page];
            if (!image || frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) throw new Error('Frame exceeds decoded atlas');
            context.clearRect(0, 0, surface.width, surface.height);
            context.drawImage(image, ...frame.rect, ...frame.offset, frame.rect[2], frame.rect[3]);
            // Force a real canvas readback without retaining or transmitting pixels.
            context.getImageData(Math.max(0, Math.min(surface.width-1, frame.offset[0])), Math.max(0, Math.min(surface.height-1, frame.offset[1])), 1, 1);
            if (context.isContextLost?.()) throw new Error('Diagnostic canvas context lost');
            drawn++;
          }
          packages.push({ id: item.id, frames: drawn, expectedFrames: item.frames.length });
        } catch { failed.push({ id: item.id, frames: drawn, expectedFrames: item.frames.length }); }
        finally { for (const image of images) { image.close(); closedBitmaps++; } if (surface) { surface.width = 0; surface.height = 0; surface = null; } }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      for (const file of config.files.filter(file => file.path.endsWith('.png') && !decoded.has(file.path))) {
        if (stopped) throw new Error('Diagnostic interrupted');
        try {
          const url = new URL(file.path, base); url.searchParams.set('epoch', epoch);
          const response = await readAsset(url); if (!response.ok) throw new Error('Auxiliary original atlas unavailable');
          const blob = await response.blob(); ensureActive();
          bitmap = await createImageBitmap(blob); ensureActive();
          surface = new OffscreenCanvas(bitmap.width, bitmap.height); const context = surface.getContext('2d');
          if (!context) throw new Error('Auxiliary diagnostic canvas unavailable');
          context.drawImage(bitmap, 0, 0); context.getImageData(0, 0, 1, 1);
          if (context.isContextLost?.()) throw new Error('Auxiliary canvas context lost');
          decoded.set(file.path, { file: file.path, width: bitmap.width, height: bitmap.height });
        } catch { failed.push({ id: `asset:${file.path}`, frames: 0, expectedFrames: 1 }); }
        finally { if (bitmap) { bitmap.close(); bitmap = null; closedBitmaps++; } if (surface) { surface.width = 0; surface.height = 0; surface = null; } }
      }
      ensureActive();
      diagnostic = { epoch, mode: 'independent-offscreen-asset-decode-draw-not-production-action-playback', packages, failed, decoded: [...decoded.values()], closedBitmaps, released: true };
      status = failed.length ? 'failed' : 'completed';
    } catch { diagnostic = { mode: 'independent-asset-diagnostic', failed: true, closedBitmaps, released: !bitmap && !surface }; status = 'failed'; }
  }
  window.__varinCompanionBenchmark = {
    start(value) { ensureActive(); const params = new URL(location.href).searchParams; if (params.get('companionPack') !== 'varin' || params.get('companionVersion') !== value.version || params.has('review')) throw new Error('Companion diagnostic requires the original pinned production surface'); if (config && JSON.stringify(config) !== JSON.stringify(value)) throw new Error('Companion benchmark identity changed'); config ??= value; document.querySelector('canvas')?.__varinObserveCompanionPaint?.(); return true; },
    recordDrag(value) { ensureActive(); if (!drag) { if (status !== 'waiting-system-drag') throw new Error('Original idle/hit observation did not precede drag'); if (!value.complete || !value.released) { status = 'failed'; return false; } drag = value; normal = observation(); normalEnd = performance.now(); pending = diagnose(); } return true; },
    poll() {
      const evidence = observation();
      if (!config || !evidence || evidence.epoch !== config.epoch || !(evidence.paints > 0 || evidence.lastSuccessfulPaint?.epoch === config.epoch)) return { status, surfaceRole: 'companion' };
      start ??= performance.now();
      let systemDrag = null;
      if (!drag && performance.now() - start >= config.idleMs) {
        const canvas = document.querySelector('canvas'), context = canvas.getContext('2d'), rect = canvas.getBoundingClientRect();
        const pixels = context.getImageData(0,0,canvas.width,canvas.height).data;
        for (let y = Math.floor(canvas.height / 4); y < canvas.height * 3/4 && !systemDrag; y += 4) for (let x = Math.floor(canvas.width / 4); x < canvas.width * 3/4; x += 4) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 200) { systemDrag = { point: { x: (rect.left + x * rect.width / canvas.width) / innerWidth, y: (rect.top + y * rect.height / canvas.height) / innerHeight }, bounds: { x: screenX, y: screenY, width: outerWidth, height: outerHeight } }; break; }
        }
        status = 'waiting-system-drag';
      }
      return { status, surfaceRole: 'companion', systemDrag, normal: normal ?? evidence, drag, diagnostic, normalObservationMs: (normalEnd ?? performance.now()) - start, idleMinimumMs: config.idleMs,
        notQualified: ['physical-cross-display', 'physical-GPU-composition', 'OS-click-through', 'all-normal-action-paths'] };
    },
    async stop() { stopped = true; controller.abort(); await pending; return { stopped: true, settled: true, released: !bitmap && !surface }; },
  };
})();
