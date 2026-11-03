/** Opt-in observation of the NORMAL packaged Electron application. Imported
 * before main only to register the recorder, never to create a replacement UI. */
import { app, webContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readIsolatedRequest } from '../tauri/scripts/benchmark-contract.mjs';
import { dispatchBenchmarkInput, evaluateBenchmark, publicRendererSample, remoteTargetExpression } from '../tauri/scripts/benchmark-driver.mjs';

const { directory, request } = await readIsolatedRequest(process.env.VARIN_DATA_DIR);
if (!app.isPackaged) throw new Error('Desktop performance must exercise a packaged full Electron product');
if (__VARIN_BENCHMARK_SOURCE_DIRTY__ || request.sourceSha !== __VARIN_BENCHMARK_SOURCE_SHA__ || request.version !== app.getVersion()) throw new Error('Electron benchmark binary belongs to another source, dirty build or version');
if (await fs.realpath(path.join(process.resourcesPath, 'web-dist')) !== await fs.realpath(request.frontendDirectory)) throw new Error('Measured frontend is not the actual packaged Electron frontend');
// Main's normal production path keeps this isolated appData/profile. No real
// user profile, importer, Host substitution, or debugging server is involved.
app.setPath('userData', path.join(directory, 'electron-profile'));
const page = await fs.readFile(path.join(import.meta.dirname, 'benchmark-page.js'), 'utf8');
const started = performance.now(), sessions = new Map(), steps = [];
let fixtureLabel = null, fixtureComplete = false, remoteLabel = null, remoteComplete = false, companionLabel = null, companionComplete = false;
let main = null, sequence = 0, stopped = false, timer = null, busy = false, lastStatus = 'waiting-ready';
const inputCounters = new Map(); let externalInputs = 0;
const write = async (name, value) => {
  const temporary = path.join(directory, `.${name}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await fs.rename(temporary, path.join(directory, name));
};
const receipt = (complete, reason) => ({ schema: 1, product: 'varin-desktop-benchmark-receipt', nonce: request.nonce,
  shell: 'electron', sourceSha: __VARIN_BENCHMARK_SOURCE_SHA__, version: app.getVersion(), scenarioSha256: request.scenarioSha256,
  inputs: request.inputs, complete, reason, inputDriver: 'chromium-devtools-input', nativeInputVerified: false, companionComplete, fixtureComplete, remoteComplete, fileSelectionDriver: 'chromium-DOM-setFileInputFiles-not-OS-chooser',
  nativeDrain: 'verify-external-process-exit', steps, rendererTargets: [...sessions.keys()], sequence,
  coverage: ['requestAnimationFrame-is-not-display-presentation', 'event-timing-is-16ms-thresholded', 'physical-input-and-cross-screen-require-platform-evidence'] });
async function finish(complete, reason) {
  if (stopped) return;
  stopped = true; clearInterval(timer);
  for (const session of sessions.values()) {
    try { await evaluateBenchmark(session.send, '(async () => ({ observer: window.__varinDesktopBenchmark.stop(), companion: await window.__varinCompanionBenchmark?.stop() }))()'); } catch { /* Destroyed pages are separately visible in the process/target record. */ }
    try { session.contents.debugger.detach(); } catch { /* Already destroyed. */ }
  }
  await write('benchmark-receipt.json', receipt(complete, reason));
  app.quit(); // Original quit lifecycle owns Host, browser, windows, and actual drain.
}
async function tick() {
  if (busy || stopped) return;
  busy = true;
  try {
    if (performance.now() - started > request.workload.timeoutMs + request.workload.readyTimeoutMs) return await finish(false, 'Product observation deadline ended');
    const alive = webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getType() !== 'devtools');
    if (!main) {
      for (const contents of alive) {
        if (contents.isLoadingMainFrame()) continue;
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        const send = (method, params) => contents.debugger.sendCommand(method, params);
        const ready = await evaluateBenchmark(send, "Boolean(window.__VARIN_RUNTIME_APIS__ && window.__VARIN_DESKTOP__ && document.querySelector('[data-varin-workbench-switcher]'))");
        if (ready) { main = contents.id; break; }
        contents.debugger.detach();
      }
      if (!main) return;
    }
    const targets = []; let companionPresent = false;
    for (const contents of alive) {
      const id = contents.id;
      let category = 'browser';
      try { const pathname = new URL(contents.getURL()).pathname; if (pathname.endsWith('companion.html')) category = 'companion'; else if (pathname.endsWith('mini-chat.html')) category = 'application:mini'; } catch { /* No URL is persisted. */ }
      let remote = false;
      if (id !== main && request.workload.remote) {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        try { remote = await evaluateBenchmark((method, params) => contents.debugger.sendCommand(method, params), remoteTargetExpression(request.workload.remote.origin)); } catch { /* Still loading; no replacement is created. */ }
        if (remote) category = 'application:remote';
      }
      if (id !== main && request.workload.remote && !remote) continue;
      const label = id === main ? 'application:main' : `${category}:${id}`;
      const companion = !!request.workload.companion && category === 'companion';
      if (companion) { companionPresent = true; if (companionLabel && companionLabel !== label) throw new Error('Original companion identity changed'); companionLabel = label; }
      if (companion && companionComplete) continue; // Original Sleep may destroy this document during the same native tick.
      const fixture = !!request.workload.browser && category === 'browser' && contents.getURL() === request.workload.browser.url;
      // Do not install a passive observer in a page that may become the fixture
      // through same-document navigation. Pin only the exact original target.
      if (id !== main && category === 'browser' && request.workload.browser && !fixture) continue;
      if (fixture) { if (fixtureLabel && fixtureLabel !== label) throw new Error('The original native fixture page identity changed or is ambiguous'); fixtureLabel = label; }
      if (remote) { if (remoteLabel && remoteLabel !== label) throw new Error('Original remote window identity changed or is ambiguous'); remoteLabel = label; }
      const targetWorkload = id === main ? request.workload : fixture ? request.workload.browser : remote ? request.workload.remote : { passive: true };
      let session = sessions.get(label);
      if (!session) {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        const send = (method, params) => contents.debugger.sendCommand(method, params);
        await send('Runtime.evaluate', { expression: page });
        await evaluateBenchmark(send, `window.__varinDesktopBenchmark.start(${JSON.stringify(targetWorkload)})`);
        session = { send, contents }; sessions.set(label, session);
      }
      // A started active document may not be replaced/replayed. Compare the
      // actual observer workload, not just existence of its global.
      if (id === main || fixture || remote || companion) {
        const matches = await evaluateBenchmark(session.send, `Boolean(window.__varinDesktopBenchmark?.matchesWorkload(${JSON.stringify(targetWorkload)}))`);
        if (!matches) throw new Error('The original active observer document or workload changed');
      }
      let sample;
      try {
        const installed = await evaluateBenchmark(session.send, 'Boolean(window.__varinDesktopBenchmark)');
        if (!installed) {
          if (id === main) throw new Error('The original measured workbench document ended');
          await session.send('Runtime.evaluate', { expression: page });
          await evaluateBenchmark(session.send, `window.__varinDesktopBenchmark.start(${JSON.stringify(targetWorkload)})`);
        }
        if (id === main) { await evaluateBenchmark(session.send, `window.__varinDesktopBenchmark.nativeCompletion(${fixtureComplete})`); await evaluateBenchmark(session.send, `window.__varinDesktopBenchmark.remoteCompletion(${remoteComplete})`); }
        if (id === main || remote) await evaluateBenchmark(session.send, 'window.__varinDesktopBenchmark.observeOwner()');
        sample = await evaluateBenchmark(session.send, 'window.__varinDesktopBenchmark.poll()');
        if (companion) {
          await evaluateBenchmark(session.send, `window.__varinCompanionBenchmark.start(${JSON.stringify(request.workload.companion)})`);
          const drag = await fs.readFile(path.join(directory, 'benchmark-companion-drag.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
          if (drag && drag.nonce === request.nonce) await evaluateBenchmark(session.send, `window.__varinCompanionBenchmark.recordDrag(${JSON.stringify(drag.result)})`);
          const observation = await evaluateBenchmark(session.send, 'window.__varinCompanionBenchmark.poll()');
          sample.companion = observation;
          if (observation.status === 'failed') throw new Error('Original companion diagnostic failed');
          companionComplete ||= observation.status === 'completed';
        }
      }
      catch { if (companion) throw new Error('Original companion observation failed'); targets.push({ label, status: 'document-ended-or-unavailable' }); continue; }
      if (sample.companion?.status === 'failed') throw new Error('Original companion diagnostic failed');
      targets.push({ label, surfaceRole: id === main ? 'main-workbench' : remote ? 'remote-workbench' : fixture ? 'native-browser' : companion ? 'companion' : category, ...publicRendererSample(sample) });
      if (id !== main) {
        const before = inputCounters.get(label) ?? 0, actual = sample.trustedInputs ?? 0;
        externalInputs += actual >= before ? actual - before : actual; inputCounters.set(label, actual);
      }
      if (remote) { remoteComplete = sample.status === 'completed'; if (sample.status === 'failed') throw new Error('Original remote UI replay failed'); steps.push(...sample.receipts); }
      if (fixture) { fixtureComplete = sample.status === 'completed'; if (sample.status === 'failed') throw new Error('Native fixture replay failed'); steps.push(...sample.receipts); }
      if (id === main) {
        steps.push(...sample.receipts); lastStatus = sample.status;
      }
      if ((id === main || fixture || remote) && sample.pendingAction) {
        await dispatchBenchmarkInput(session.send, sample.pendingAction, { uploadFile: path.join(directory, 'benchmark-upload.txt') });
        await evaluateBenchmark(session.send, `window.__varinDesktopBenchmark.dispatched(${JSON.stringify(sample.pendingAction.id)})`);
      }
    }
    const mainSession = sessions.get('application:main');
    if (mainSession) { await evaluateBenchmark(mainSession.send, `window.__varinDesktopBenchmark.externalInputs(${externalInputs})`); await evaluateBenchmark(mainSession.send, `window.__varinDesktopBenchmark.companionCompletion(${companionComplete})`); await evaluateBenchmark(mainSession.send, `window.__varinDesktopBenchmark.companionClosed(${companionComplete && !companionPresent})`); }
    const record = { schema: 1, nonce: request.nonce, sequence: sequence++, elapsedMs: performance.now() - started, targets };
    await fs.appendFile(path.join(directory, 'benchmark-renderer.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    await write('benchmark-live.json', record);
    if (lastStatus === 'completed') { const complete = (!request.workload.browser || fixtureComplete) && (!request.workload.remote || remoteComplete) && (!request.workload.companion || companionComplete); await finish(complete, complete ? null : 'Original auxiliary product surface did not complete'); }
    else if (lastStatus === 'failed') await finish(false, targets.find(target => target.label === 'application:main')?.error ?? 'Workload failed');
  } catch { await finish(false, 'Native benchmark observation or input failed; outcome is not accepted'); }
  finally { busy = false; }
}
app.whenReady().then(() => { timer = setInterval(() => void tick(), request.sampleIntervalMs); void tick(); });
app.once('will-quit', () => { clearInterval(timer); });
