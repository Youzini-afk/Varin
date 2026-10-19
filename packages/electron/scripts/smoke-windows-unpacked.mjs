#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VARIN_WORKSPACE_RECOVERY_SERVICE_ID, VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION } from '../../extension-contract/src/services.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const electronDir = path.resolve(__dirname, '..');
const appPath = path.resolve(process.argv[2] ?? path.join(electronDir, 'dist', 'win-unpacked', 'Varin.exe'));
const smokeEnvironment = { ...process.env };
for (const variable of [
  'VARIN_AGENT_DIR',
  'VARIN_RUNTIME_SOURCE',
  'VARIN_SKIP_LOCAL_SERVER',
  'VARIN_SMOKE_PROFILE_SOURCE',
  'VARIN_SMOKE_LOCAL_SEMANTIC_PACK',
  'ELECTRON_RUN_AS_NODE',
  'NODE_PATH',
]) {
  delete smokeEnvironment[variable];
}
if (process.platform !== 'win32') {
  throw new Error('The unpacked Windows smoke test must run on Windows.');
}
if (!existsSync(appPath)) {
  throw new Error(`Missing unpacked Varin executable at ${appPath}`);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const DEVTOOLS_REQUEST_TIMEOUT_MS = 20_000;
const MONACO_SMOKE_ENABLED = process.env.VARIN_MONACO_SMOKE === '1';
const localSemanticPack = process.env.VARIN_SMOKE_LOCAL_SEMANTIC_PACK?.trim()
  ? path.resolve(process.env.VARIN_SMOKE_LOCAL_SEMANTIC_PACK.trim())
  : null;

const formatConsoleArg = (arg) => {
  if (arg == null) return String(arg);
  if (arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean' || arg.type === 'undefined') {
    return String(arg.value);
  }
  if (typeof arg.description === 'string' && arg.description.length > 0) return arg.description.slice(0, 500);
  if (arg.value !== undefined) {
    try {
      return typeof arg.value === 'string' ? arg.value.slice(0, 500) : JSON.stringify(arg.value).slice(0, 500);
    } catch {
      return String(arg.value).slice(0, 500);
    }
  }
  return arg.type ?? 'unknown';
};

const describeSmokeFailure = (reason, extras = {}) => {
  const lastState = extras.lastState ?? extras.state ?? null;
  const payload = {
    diagnostics: extras.diagnostics ?? lastState?.diagnostics ?? null,
    lastState,
    rendererConsole: extras.consoleMessages ?? [],
    runtimeManager: extras.runtimeManager ?? null,
    runtimeExceptions: extras.exceptions ?? [],
  };
  return new Error(`${reason}\n${JSON.stringify(payload, null, 2)}`);
};

const postJson = async (baseUrl, route, body, label) => {
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  return payload;
};

const LOCAL_SEMANTIC_STATUSES = new Set(['not-installed', 'installing', 'ready', 'failed']);

const readLocalSemanticStatus = async (baseUrl, label) => {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/harness/local-semantic`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok || !payload || !LOCAL_SEMANTIC_STATUSES.has(payload.status)) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  return payload;
};

const runPackagedLocalSemanticSmoke = async (baseUrl) => {
  const initial = await readLocalSemanticStatus(baseUrl, 'Packaged local semantic status');
  if (initial.status !== 'not-installed') {
    throw new Error(`Clean packaged local semantic component was not absent: ${JSON.stringify(initial)}`);
  }
  if (!localSemanticPack) return { imported: false, status: initial.status };

  let packStat;
  try {
    packStat = await fsp.stat(localSemanticPack);
  } catch (error) {
    throw new Error(`Missing local semantic component pack at ${localSemanticPack}`, { cause: error });
  }
  if (!packStat.isFile() || packStat.size === 0) {
    throw new Error(`Local semantic component pack is empty or not a file: ${localSemanticPack}`);
  }
  const form = new FormData();
  form.append(
    'file',
    new Blob([await fsp.readFile(localSemanticPack)], { type: 'application/gzip' }),
    path.basename(localSemanticPack),
  );
  const importResponse = await fetch(`${baseUrl}/api/harness/local-semantic/import`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const importText = await importResponse.text();
  if (importResponse.status !== 202) {
    throw new Error(`Packaged local semantic import returned HTTP ${importResponse.status}: ${importText}`);
  }

  let status = await readLocalSemanticStatus(baseUrl, 'Packaged local semantic import progress');
  const deadline = Date.now() + 120_000;
  while (status.status !== 'ready' && Date.now() < deadline) {
    if (status.status === 'failed') {
      throw new Error(`Packaged local semantic import failed: ${JSON.stringify(status)}`);
    }
    await delay(500);
    status = await readLocalSemanticStatus(baseUrl, 'Packaged local semantic import progress');
  }
  if (status.status !== 'ready') {
    throw new Error(`Packaged local semantic import did not become ready: ${JSON.stringify(status)}`);
  }
  return {
    imported: true,
    installedBytes: status.installedBytes,
    status: status.status,
    version: status.version,
  };
};

const runPackagedBuiltinLanguageSmoke = async (baseUrl, workspaceRoot) => {
  const workspace = await postJson(
    baseUrl,
    '/api/documents/workspace/resolve',
    { path: workspaceRoot },
    'Packaged language workspace resolution',
  );
  if (typeof workspace?.workspaceId !== 'string' || workspace.workspaceId.length === 0) {
    throw new Error(`Packaged language workspace returned ${JSON.stringify(workspace)}`);
  }

  const resource = { workspaceId: workspace.workspaceId, resourceId: 'packaged-language-smoke.ts' };
  const languageId = 'typescript';
  let opened = false;
  let result;
  let primaryFailure;
  try {
    const synced = await postJson(baseUrl, '/api/language/sync', {
      resource,
      languageId,
      documentVersion: 1,
      reason: 'open',
      content: 'export const packagedLanguageSmoke: number = 1;\n',
    }, 'Packaged built-in language sync');
    if (synced?.status !== 'synced') {
      throw new Error(`Packaged built-in language sync returned ${JSON.stringify(synced)}`);
    }
    opened = true;

    const status = await postJson(
      baseUrl,
      '/api/language/status',
      { workspaceId: workspace.workspaceId, languageId },
      'Packaged built-in language status',
    );
    if (status?.status !== 'ready' || status.providerId !== 'varin.typescript-language') {
      throw new Error(`Packaged built-in language provider returned ${JSON.stringify(status)}`);
    }

    const hover = await postJson(baseUrl, '/api/language/feature', {
      method: 'hover',
      request: {
        resource,
        languageId,
        documentVersion: 1,
        position: { line: 0, character: 13 },
      },
    }, 'Packaged built-in language hover');
    if (hover?.status !== 'ready') {
      throw new Error(`Packaged built-in language hover returned ${JSON.stringify(hover)}`);
    }
    result = {
      generation: status.generation,
      providerId: status.providerId,
      status: status.status,
    };
  } catch (error) {
    primaryFailure = error;
  }

  const cleanupFailures = [];
  if (opened) {
    try {
      await postJson(baseUrl, '/api/language/sync', {
        resource,
        languageId,
        documentVersion: 1,
        reason: 'close',
      }, 'Packaged built-in language close');
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await postJson(
      baseUrl,
      '/api/language/dispose-workspace',
      { workspaceId: workspace.workspaceId },
      'Packaged built-in language workspace disposal',
    );
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], 'Packaged language smoke and cleanup failed');
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Packaged language smoke cleanup failed');
  }
  return result;
};

const runPackagedRecoverySmoke = async (baseUrl) => {
  const payload = await postJson(baseUrl, '/api/varin/extensions/v1/services/invoke', {
    args: [],
    method: 'listStorageWorkspaces',
    serviceId: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
    version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
  }, 'Packaged built-in recovery inventory');
  const result = payload?.result;
  if (result?.status !== 'ready' || !Array.isArray(result.workspaces)) {
    throw new Error(`Packaged built-in recovery returned ${JSON.stringify(payload)}`);
  }
  return { status: result.status, workspaceCount: result.workspaces.length };
};

const connectDevTools = (webSocketDebuggerUrl) => new Promise((resolve, reject) => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const consoleMessages = [];
  const exceptions = [];
  let nextId = 1;
  const connectionTimer = setTimeout(() => {
    socket.close();
    reject(new Error('Timed out connecting to the packaged renderer.'));
  }, DEVTOOLS_REQUEST_TIMEOUT_MS);
  const rejectConnection = () => {
    clearTimeout(connectionTimer);
    reject(new Error('Unable to connect to the packaged renderer.'));
  };
  const send = (method, params) => new Promise((sendResolve, sendReject) => {
    const id = nextId;
    nextId += 1;
    const requestTimer = setTimeout(() => {
      pending.delete(id);
      sendReject(new Error(`Timed out calling ${method}.`));
    }, DEVTOOLS_REQUEST_TIMEOUT_MS);
    pending.set(id, {
      reject: (error) => {
        clearTimeout(requestTimer);
        sendReject(error);
      },
      resolve: (value) => {
        clearTimeout(requestTimer);
        sendResolve(value);
      },
    });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(requestTimer);
      sendReject(error);
    }
  });

  socket.addEventListener('error', rejectConnection, { once: true });
  socket.addEventListener('open', () => {
    clearTimeout(connectionTimer);
    socket.removeEventListener('error', rejectConnection);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled') {
        const params = message.params ?? {};
        consoleMessages.push({
          text: (params.args ?? []).map(formatConsoleArg).join(' ').slice(0, 2_000),
          timestamp: params.timestamp,
          type: params.type ?? 'log',
        });
        if (consoleMessages.length > 80) consoleMessages.shift();
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params?.exceptionDetails ?? {};
        exceptions.push({
          text: detail.text ?? detail.exception?.description ?? JSON.stringify(detail).slice(0, 1_000),
        });
        if (exceptions.length > 20) exceptions.shift();
        return;
      }
      if (typeof message.id !== 'number') return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) request.reject(new Error('Packaged renderer disconnected.'));
      pending.clear();
    });

    Promise.all([send('Runtime.enable'), send('Page.enable')]).then(() => {
      resolve({
        close: () => socket.close(),
        consoleMessages,
        evaluate: (expression) => send('Runtime.evaluate', {
          awaitPromise: true,
          expression,
          returnByValue: true,
        }),
        exceptions,
        navigate: (url) => send('Page.navigate', { url }),
      });
    }).catch(reject);
  }, { once: true });
});

const runPackagedMobileEntrySmoke = async (devTools) => {
  const exceptionCountBeforeNavigation = devTools.exceptions.length;
  const navigation = await devTools.navigate('varin-ui://app/mobile.html');
  if (navigation?.errorText) {
    throw describeSmokeFailure(`Unable to navigate to the packaged mobile entry: ${navigation.errorText}`, {
      consoleMessages: devTools.consoleMessages,
      exceptions: devTools.exceptions,
    });
  }

  let lastState;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await delay(250);
    const evaluation = await devTools.evaluate(`(() => {
      const root = document.querySelector('#root');
      const bodyText = document.body?.innerText?.slice(0, 4000) ?? '';
      const resources = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => typeof name === 'string');
      return {
        bodyText,
        href: window.location.href,
        layoutKind: document.querySelector('[data-mobile-layout-kind]')?.getAttribute('data-mobile-layout-kind') ?? null,
        layoutTier: document.querySelector('[data-mobile-layout-tier]')?.getAttribute('data-mobile-layout-tier') ?? null,
        monacoResources: resources.filter((name) => name.toLowerCase().includes('monaco')),
        mounted: root instanceof HTMLElement && root.childElementCount > 0,
        readyState: document.readyState,
        visualSurface: root instanceof HTMLElement && root.querySelector('main, svg, [data-mobile-layout-tier]') !== null,
      };
    })()`);
    if (evaluation?.exceptionDetails) continue;
    lastState = evaluation?.result?.value;
    if (/Minified React error|Maximum update depth|发生错误|Something went wrong/i.test(lastState?.bodyText ?? '')) {
      throw describeSmokeFailure('Packaged mobile entry entered its error boundary.', {
        consoleMessages: devTools.consoleMessages,
        exceptions: devTools.exceptions,
        state: lastState,
      });
    }
    if (lastState?.mounted === true && lastState?.readyState === 'complete' && lastState?.visualSurface === true) {
      const newExceptions = devTools.exceptions.slice(exceptionCountBeforeNavigation);
      if (newExceptions.length > 0) {
        throw describeSmokeFailure('Packaged mobile entry raised a renderer exception.', {
          consoleMessages: devTools.consoleMessages,
          exceptions: newExceptions,
          state: lastState,
        });
      }
      if ((lastState.monacoResources?.length ?? 0) > 0) {
        throw describeSmokeFailure('Packaged mobile entry loaded Monaco resources.', {
          consoleMessages: devTools.consoleMessages,
          exceptions: devTools.exceptions,
          state: lastState,
        });
      }
      return lastState;
    }
  }
  throw describeSmokeFailure('Packaged mobile entry did not mount.', {
    consoleMessages: devTools.consoleMessages,
    exceptions: devTools.exceptions,
    state: lastState,
  });
};

const runMonacoSmoke = async (devTools) => {
  const navigation = await devTools.navigate('varin-ui://app/monaco-smoke.html');
  if (navigation?.errorText) {
    throw describeSmokeFailure(`Unable to navigate to the Monaco smoke entry: ${navigation.errorText}`, {
      consoleMessages: devTools.consoleMessages,
      exceptions: devTools.exceptions,
    });
  }

  let lastState;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(250);
    const evaluation = await devTools.evaluate('window.__varinMonacoSmoke ?? null');
    if (evaluation?.exceptionDetails) continue;
    lastState = evaluation?.result?.value;
    if (lastState?.status === 'failed') {
      throw describeSmokeFailure('Packaged Monaco fixture failed.', {
        consoleMessages: devTools.consoleMessages,
        exceptions: devTools.exceptions,
        state: lastState,
      });
    }
    if (lastState?.status === 'ready') {
      if (lastState.disposed !== true || lastState.runtime?.workerCreatedCount < 1) {
        throw describeSmokeFailure('Packaged Monaco fixture did not dispose cleanly.', {
          consoleMessages: devTools.consoleMessages,
          exceptions: devTools.exceptions,
          state: lastState,
        });
      }
      const mobile = await runPackagedMobileEntrySmoke(devTools);
      return { ...lastState, mobile };
    }
  }
  throw describeSmokeFailure('Packaged Monaco fixture did not become ready.', {
    consoleMessages: devTools.consoleMessages,
    exceptions: devTools.exceptions,
    state: lastState,
  });
};

const waitForRenderer = async (userDataDir) => {
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  let debugPort;
  for (let attempt = 0; attempt < 80 && debugPort === undefined; attempt += 1) {
    await delay(250);
    const activePort = await fsp.readFile(activePortPath, 'utf8').catch(() => '');
    const candidate = Number(activePort.split(/\r?\n/, 1)[0]);
    if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65_535) debugPort = candidate;
  }
  if (debugPort === undefined) throw new Error('Packaged renderer did not publish its DevTools port.');

  let target;
  for (let attempt = 0; attempt < 80 && target === undefined; attempt += 1) {
    await delay(250);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    }).then((response) => response.json()).catch(() => []);
    target = targets.find((candidate) => (
      candidate?.type === 'page'
      && typeof candidate.url === 'string'
      && candidate.url.startsWith('varin-ui://app')
      && typeof candidate.webSocketDebuggerUrl === 'string'
    ));
  }
  if (!target) throw new Error('Packaged renderer did not expose a DevTools target.');

  const devTools = await connectDevTools(target.webSocketDebuggerUrl);
  try {
    let lastState;
    let continuedFromLocalWelcome = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const evaluation = await devTools.evaluate(`(() => {
        let diagnostics = null;
        try {
          diagnostics = window.__varinStartupDiagnostics ?? null;
        } catch {
          diagnostics = { error: 'startup diagnostics threw' };
        }
        return {
          bodyText: document.body?.innerText?.slice(0, 4000) ?? '',
          diagnostics,
          localRuntimeContinueReady: document.querySelector('[data-native-local-runtime-continue="true"]:not(:disabled)') !== null,
          mainWorkspace: window.__varinStartupDiagnostics?.bootView?.screen === 'main' && window.__varinStartupDiagnostics?.runtimeReady === true && window.__varinStartupDiagnostics?.catalogLoaded === true && !window.__varinStartupDiagnostics?.catalogError,
          ready: window.__varinAppReady === true,
        };
      })()`);
      if (evaluation?.exceptionDetails) {
        throw describeSmokeFailure(
          `Packaged renderer evaluation failed: ${evaluation.exceptionDetails.text}`,
          { consoleMessages: devTools.consoleMessages, exceptions: devTools.exceptions },
        );
      }
      lastState = evaluation?.result?.value;
      if (/Minified React error|Maximum update depth|发生错误|Something went wrong/i.test(lastState?.bodyText ?? '')) {
        throw describeSmokeFailure('Packaged renderer entered its error boundary.', {
          consoleMessages: devTools.consoleMessages,
          exceptions: devTools.exceptions,
          lastState,
        });
      }
      if (lastState?.ready === true && lastState?.mainWorkspace === true) {
        const monaco = MONACO_SMOKE_ENABLED ? await runMonacoSmoke(devTools) : null;
        return { consoleMessages: devTools.consoleMessages, exceptions: devTools.exceptions, mode: 'main', monaco, state: lastState };
      }
      if (!continuedFromLocalWelcome && lastState?.localRuntimeContinueReady === true) {
        const continuation = await devTools.evaluate(`(() => {
          const action = document.querySelector('[data-native-local-runtime-continue="true"]:not(:disabled)');
          if (!(action instanceof HTMLButtonElement)) return false;
          action.click();
          return true;
        })()`);
        if (continuation?.exceptionDetails) {
          throw describeSmokeFailure(
            `Packaged local-runtime welcome continuation failed: ${continuation.exceptionDetails.text}`,
            { consoleMessages: devTools.consoleMessages, exceptions: devTools.exceptions, lastState },
          );
        }
        continuedFromLocalWelcome = continuation?.result?.value === true;
      }
      await delay(250);
    }
    throw describeSmokeFailure(
      lastState?.ready === true
        ? 'Packaged renderer became ready without the main workspace.'
        : 'Packaged renderer did not become app-ready.',
      { consoleMessages: devTools.consoleMessages, exceptions: devTools.exceptions, lastState },
    );
  } finally {
    devTools.close();
  }
};

const smokeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-win-smoke-'));
const userDataDir = path.join(smokeRoot, 'user-data');
const smokeWorkspaceRoot = path.join(smokeRoot, 'workspace');
try {
  await fsp.mkdir(userDataDir, { recursive: true });
  await fsp.mkdir(smokeWorkspaceRoot, { recursive: true });
  await fsp.writeFile(
    path.join(smokeWorkspaceRoot, 'packaged-language-smoke.ts'),
    'export const packagedLanguageSmoke: number = 1;\n',
    'utf8',
  );
} catch (error) {
  await fsp.rm(smokeRoot, { recursive: true, force: true });
  throw error;
}
const logPath = path.join(userDataDir, 'logs', 'main.log');
let processOutput = '';
const child = spawn(appPath, [
  `--user-data-dir=${userDataDir}`,
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
], {
  cwd: path.dirname(appPath),
  env: {
    ...smokeEnvironment,
    VARIN_DATA_DIR: userDataDir,
    VARIN_WORKSPACE_ROOT: smokeWorkspaceRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    processOutput = (processOutput + chunk.toString()).slice(-6_000);
  });
}
let spawnError;
child.once('error', (error) => {
  spawnError = error;
});

const readLog = async () => fsp.readFile(logPath, 'utf8').catch(() => '');

try {
  let port;
  for (let attempt = 0; attempt < 60 && port === undefined; attempt += 1) {
    await delay(500);
    if (spawnError) throw spawnError;
    const log = await readLog();
    const match = log.match(/server listening on 127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    if (child.exitCode !== null && port === undefined) {
      throw new Error(`Packaged Varin exited before startup completed (code ${child.exitCode}).\n${log}`);
    }
  }
  if (port === undefined) throw new Error(`Packaged Varin did not become ready.\n${await readLog()}`);

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthResponse = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!healthResponse.ok) throw new Error(`Packaged health check failed with HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (health?.status !== 'ok') throw new Error(`Packaged health check returned ${JSON.stringify(health)}`);

  const localSemantic = await runPackagedLocalSemanticSmoke(baseUrl);
  const builtinLanguage = await runPackagedBuiltinLanguageSmoke(baseUrl, smokeWorkspaceRoot);
  const builtinRecovery = await runPackagedRecoverySmoke(baseUrl);

  const terminalResponse = await fetch(`${baseUrl}/api/terminal/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols: 80, cwd: smokeWorkspaceRoot, rows: 24 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!terminalResponse.ok) {
    throw new Error(`Packaged terminal create failed with HTTP ${terminalResponse.status}: ${await terminalResponse.text()}`);
  }
  const terminal = await terminalResponse.json();
  if (terminal?.status !== 'running' || typeof terminal.sessionId !== 'string') {
    throw new Error(`Packaged terminal returned ${JSON.stringify(terminal)}`);
  }

  const closeResponse = await fetch(`${baseUrl}/api/terminal/${encodeURIComponent(terminal.sessionId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(15_000),
  });
  if (!closeResponse.ok) throw new Error(`Packaged terminal close failed with HTTP ${closeResponse.status}`);
  const closed = await closeResponse.json();
  if (closed?.success !== true) throw new Error(`Packaged terminal close returned ${JSON.stringify(closed)}`);

  const renderer = await waitForRenderer(userDataDir);
  if (health.kernel?.ready !== true || !health.kernel?.epoch) {
    throw new Error(`Packaged native kernel is unavailable: ${JSON.stringify(health.kernel)}`);
  }
  console.log(JSON.stringify({
    appPath,
    builtinLanguage,
    builtinRecovery,
    health: 'ok',
    localSemantic,
    nativeKernel: health.kernel,
    profile: 'clean',
    renderer: renderer.state?.ready === true ? 'app-ready' : 'not-ready',
    monaco: renderer.monaco,
    terminal: 'create-close-ok',
  }, null, 2));
} catch (error) {
  const log = await readLog();
  const suffix = `\n--- process output ---\n${processOutput}\n--- main.log ---\n${log.slice(-6_000)}`;
  if (error instanceof Error) {
    throw new Error(`${error.message}${suffix}`, { cause: error });
  }
  throw new Error(`${String(error)}${suffix}`);
} finally {
  if (child.exitCode === null) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  await delay(500);
  // Windows can keep the native data directory open briefly after the process tree
  // has been terminated. Retry the removal instead of turning that teardown
  // race into a failed package smoke check.
  await fsp.rm(smokeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
