/** Opt-in observation of the NORMAL packaged Electron application. Imported
 * before main only to register the recorder, never to create a replacement UI. */
import { app, webContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readIsolatedRequest } from '../tauri/scripts/benchmark-contract.mjs';
import { dispatchBenchmarkInput, evaluateBenchmark, publicRendererSample } from '../tauri/scripts/benchmark-driver.mjs';

const { directory, request } = await readIsolatedRequest(process.env.VARIN_DATA_DIR);
if (!app.isPackaged) throw new Error('Desktop performance must exercise a packaged full Electron product');
if (__VARIN_BENCHMARK_SOURCE_DIRTY__ || request.sourceSha !== __VARIN_BENCHMARK_SOURCE_SHA__ || request.version !== app.getVersion()) throw new Error('Electron benchmark binary belongs to another source, dirty build or version');
if (await fs.realpath(path.join(process.resourcesPath, 'web-dist')) !== await fs.realpath(request.frontendDirectory)) throw new Error('Measured frontend is not the actual packaged Electron frontend');
// Main's normal production path keeps this isolated appData/profile. No real
// user profile, importer, Host substitution, or debugging server is involved.
app.setPath('userData', path.join(directory, 'electron-profile'));
const page = await fs.readFile(path.join(import.meta.dirname, 'benchmark-page.js'), 'utf8');
const started = performance.now(), sessions = new Map(), steps = [];
let main = null, sequence = 0, stopped = false, timer = null, busy = false, lastStatus = 'waiting-ready';
const inputCounters = new Map(); let externalInputs = 0;
const write = async (name, value) => {
  const temporary = path.join(directory, `.${name}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await fs.rename(temporary, path.join(directory, name));
};
const receipt = (complete, reason) => ({ schema: 1, product: 'varin-desktop-benchmark-receipt', nonce: request.nonce,
  shell: 'electron', sourceSha: __VARIN_BENCHMARK_SOURCE_SHA__, version: app.getVersion(), scenarioSha256: request.scenarioSha256,
  inputs: request.inputs, complete, reason, inputDriver: 'chromium-devtools-input', nativeInputVerified: false,
  nativeDrain: 'verify-external-process-exit', steps, rendererTargets: [...sessions.keys()], sequence,
  coverage: ['requestAnimationFrame-is-not-display-presentation', 'event-timing-is-16ms-thresholded', 'physical-input-and-cross-screen-require-platform-evidence'] });
async function finish(complete, reason) {
  if (stopped) return;
  stopped = true; clearInterval(timer);
  for (const session of sessions.values()) {
    try { await evaluateBenchmark(session.send, 'window.__varinDesktopBenchmark.stop()'); } catch { /* Destroyed pages are separately visible in the process/target record. */ }
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
    const targets = [];
    for (const contents of alive) {
      const id = contents.id;
      let category = 'browser';
      try { const pathname = new URL(contents.getURL()).pathname; if (pathname.endsWith('companion.html')) category = 'companion'; else if (pathname.endsWith('mini-chat.html')) category = 'application:mini'; } catch { /* No URL is persisted. */ }
      const label = id === main ? 'application:main' : `${category}:${id}`;
      let session = sessions.get(label);
      if (!session) {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        const send = (method, params) => contents.debugger.sendCommand(method, params);
        await send('Runtime.evaluate', { expression: page });
        await evaluateBenchmark(send, `window.__varinDesktopBenchmark.start(${JSON.stringify(id === main ? request.workload : { passive: true })})`);
        session = { send, contents }; sessions.set(label, session);
      }
      let sample;
      try {
        const installed = await evaluateBenchmark(session.send, 'Boolean(window.__varinDesktopBenchmark)');
        if (!installed) {
          if (id === main) throw new Error('The original measured workbench document ended');
          await session.send('Runtime.evaluate', { expression: page });
          await evaluateBenchmark(session.send, 'window.__varinDesktopBenchmark.start({passive:true})');
        }
        sample = await evaluateBenchmark(session.send, 'window.__varinDesktopBenchmark.poll()');
      }
      catch { targets.push({ label, status: 'document-ended-or-unavailable' }); continue; }
      targets.push({ label, ...publicRendererSample(sample) });
      if (id !== main) {
        const before = inputCounters.get(label) ?? 0, actual = sample.trustedInputs ?? 0;
        externalInputs += actual >= before ? actual - before : actual; inputCounters.set(label, actual);
      }
      if (id === main) {
        steps.push(...sample.receipts); lastStatus = sample.status;
        if (sample.pendingAction) {
          await dispatchBenchmarkInput(session.send, sample.pendingAction);
          await evaluateBenchmark(session.send, `window.__varinDesktopBenchmark.dispatched(${JSON.stringify(sample.pendingAction.id)})`);
        }
      }
    }
    const mainSession = sessions.get('application:main');
    if (mainSession) await evaluateBenchmark(mainSession.send, `window.__varinDesktopBenchmark.externalInputs(${externalInputs})`);
    const record = { schema: 1, nonce: request.nonce, sequence: sequence++, elapsedMs: performance.now() - started, targets };
    await fs.appendFile(path.join(directory, 'benchmark-renderer.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    await write('benchmark-live.json', record);
    if (lastStatus === 'completed') await finish(true, null);
    else if (lastStatus === 'failed') await finish(false, targets.find(target => target.label === 'application:main')?.error ?? 'Workload failed');
  } catch { await finish(false, 'Native benchmark observation or input failed; outcome is not accepted'); }
  finally { busy = false; }
}
app.whenReady().then(() => { timer = setInterval(() => void tick(), request.sampleIntervalMs); void tick(); });
app.once('will-quit', () => { clearInterval(timer); });
