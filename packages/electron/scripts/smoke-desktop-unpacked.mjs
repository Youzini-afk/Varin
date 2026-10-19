#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const DEVTOOLS_TIMEOUT_MS = 20_000;

const formatConsoleArg = (argument) => {
  if (argument == null) return String(argument);
  if (['string', 'number', 'boolean', 'undefined'].includes(argument.type)) {
    return String(argument.value);
  }
  if (typeof argument.description === 'string') return argument.description.slice(0, 500);
  try {
    return JSON.stringify(argument.value).slice(0, 500);
  } catch {
    return argument.type ?? 'unknown';
  }
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
  }, DEVTOOLS_TIMEOUT_MS);

  const send = (method, params) => new Promise((sendResolve, sendReject) => {
    const id = nextId;
    nextId += 1;
    const requestTimer = setTimeout(() => {
      pending.delete(id);
      sendReject(new Error(`Timed out calling ${method}.`));
    }, DEVTOOLS_TIMEOUT_MS);
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

  const rejectConnection = () => {
    clearTimeout(connectionTimer);
    reject(new Error('Unable to connect to the packaged renderer.'));
  };
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
    send('Runtime.enable').then(() => resolve({
      close: () => socket.close(),
      consoleMessages,
      evaluate: (expression) => send('Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true,
      }),
      exceptions,
    })).catch(reject);
  }, { once: true });
});

const waitForRenderer = async (userDataDir) => {
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  let debugPort;
  for (let attempt = 0; attempt < 120 && debugPort === undefined; attempt += 1) {
    await delay(250);
    const activePort = await fsp.readFile(activePortPath, 'utf8').catch(() => '');
    const candidate = Number(activePort.split(/\r?\n/, 1)[0]);
    if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65_535) debugPort = candidate;
  }
  if (debugPort === undefined) throw new Error('Packaged renderer did not publish its DevTools port.');

  let target;
  for (let attempt = 0; attempt < 120 && target === undefined; attempt += 1) {
    await delay(250);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    }).then((response) => response.json()).catch(() => []);
    target = targets.find((candidate) => (
      candidate?.type === 'page'
      && typeof candidate.url === 'string'
      && candidate.url.split(/[?#]/, 1)[0] === 'varin-ui://app/index.html'
      && typeof candidate.webSocketDebuggerUrl === 'string'
    ));
  }
  if (!target) throw new Error('Packaged renderer did not expose a DevTools target.');

  const devTools = await connectDevTools(target.webSocketDebuggerUrl);
  try {
    let lastState;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const evaluation = await devTools.evaluate(`(() => ({
        apiBaseUrl: typeof window.__VARIN_API_BASE_URL__ === 'string' ? window.__VARIN_API_BASE_URL__ : '',
        bodyText: document.body?.innerText?.slice(0, 4000) ?? '',
        diagnostics: window.__varinStartupDiagnostics ?? null,
        href: window.location.href,
        localOrigin: typeof window.__VARIN_LOCAL_ORIGIN__ === 'string' ? window.__VARIN_LOCAL_ORIGIN__ : '',
        mainWorkspace: window.__varinStartupDiagnostics?.bootView?.screen === 'main' && window.__varinStartupDiagnostics?.runtimeReady === true && window.__varinStartupDiagnostics?.catalogLoaded === true && !window.__varinStartupDiagnostics?.catalogError,
        ready: window.__varinAppReady === true,
      }))()`);
      if (evaluation?.exceptionDetails) {
        throw new Error(`Packaged renderer evaluation failed: ${evaluation.exceptionDetails.text}`);
      }
      lastState = evaluation?.result?.value;
      if (/Minified React error|Maximum update depth|发生错误|Something went wrong/i.test(lastState?.bodyText ?? '')) {
        throw new Error('Packaged renderer entered its error boundary.');
      }
      if (lastState?.ready === true && lastState.mainWorkspace === true) {
        return {
          consoleMessages: devTools.consoleMessages,
          exceptions: devTools.exceptions,
          mode: 'main',
          state: lastState,
        };
      }
      await delay(250);
    }
    throw new Error(`Packaged renderer did not become app-ready: ${JSON.stringify(lastState)}`);
  } catch (error) {
    const diagnostics = {
      rendererConsole: devTools.consoleMessages,
      runtimeExceptions: devTools.exceptions,
    };
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics, null, 2)}`);
  } finally {
    devTools.close();
  }
};

const waitForExit = (child, milliseconds) => new Promise((resolve) => {
  if (child.exitCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(false), milliseconds);
  child.once('exit', () => {
    clearTimeout(timer);
    resolve(true);
  });
});

export async function smokeDesktopApp(executable, appArguments = []) {
  const appPath = path.resolve(executable ?? '');
  if (!executable || !existsSync(appPath)) throw new Error(`Missing packaged Varin executable at ${appPath}`);
  const smokeEnvironment = { ...process.env };
  for (const variable of [
    'VARIN_AGENT_DIR', 'VARIN_RUNTIME_SOURCE', 'VARIN_SKIP_LOCAL_SERVER', 'VARIN_SERVER_URL',
    'VARIN_SMOKE_PROFILE_SOURCE', 'VARIN_SMOKE_LOCAL_SEMANTIC_PACK', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH',
  ]) delete smokeEnvironment[variable];
  const smokeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-desktop-smoke-'));
  const userDataDir = path.join(smokeRoot, 'user-data');
  const workspaceRoot = path.join(smokeRoot, 'workspace');
  await fsp.mkdir(workspaceRoot);
  await fsp.mkdir(userDataDir);
  // Select the embedded Host up front; completing onboarding restarts the app.
  await fsp.writeFile(path.join(userDataDir, 'settings.json'), JSON.stringify({
    desktopDefaultHostId: 'local',
    desktopInitialHostChoiceCompleted: true,
  }));
  const logPaths = [
    path.join(userDataDir, 'logs', 'main.log'),
    ...(process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Logs', 'Varin', 'main.log')] : []),
    ...(process.platform === 'linux' ? [
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Varin', 'logs', 'main.log'),
    ] : []),
  ];
  let processOutput = '';
  const child = spawn(appPath, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    ...appArguments,
  ], {
    cwd: path.dirname(appPath),
    env: {
      ...smokeEnvironment,
      VARIN_STARTUP_PERF: '1',
      VARIN_DATA_DIR: userDataDir,
      VARIN_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      processOutput = (processOutput + chunk.toString()).slice(-6_000);
    });
  }
  const launched = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });

  const readLog = async () => {
    for (const logPath of logPaths) {
      const content = await fsp.readFile(logPath, 'utf8').catch(() => '');
      if (content) return content;
    }
    return '';
  };

  try {
    await launched;
    const renderer = await waitForRenderer(userDataDir);
    if (child.exitCode !== null) {
      throw new Error(`Packaged Varin exited before startup completed (code ${child.exitCode}).`);
    }
    const runtimeValue = renderer.state?.localOrigin || renderer.state?.apiBaseUrl;
    let runtimeUrl;
    try {
      runtimeUrl = new URL(runtimeValue);
    } catch {
      throw new Error(`Packaged renderer did not expose its local runtime origin: ${String(runtimeValue || '(missing)')}`);
    }
    if (!['http:', 'https:'].includes(runtimeUrl.protocol)
      || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(runtimeUrl.hostname)) {
      throw new Error(`Packaged renderer exposed a non-local runtime origin: ${runtimeUrl.origin}`);
    }
    const baseUrl = runtimeUrl.origin;
    const healthResponse = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    const health = await healthResponse.json();
    if (!healthResponse.ok || health?.status !== 'ok') {
      throw new Error(`Packaged health check returned HTTP ${healthResponse.status}: ${JSON.stringify(health)}`);
    }
    if (health.kernel?.ready !== true || !health.kernel?.epoch) {
      throw new Error(`Packaged native kernel is unavailable: ${JSON.stringify(health.kernel)}`);
    }

    console.log(JSON.stringify({
      appPath,
      architecture: process.arch,
      health: 'ok',
      platform: process.platform,
      renderer: renderer.mode,
      nativeKernel: health.kernel,
    }, null, 2));
  } catch (error) {
    const log = await readLog();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n--- process output ---\n${processOutput}\n--- main.log ---\n${log.slice(-6_000)}`);
  } finally {
    if (child.pid) {
      if (child.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        } else child.kill('SIGTERM');
      }
      if (!(await waitForExit(child, 5_000)) && child.exitCode === null) child.kill('SIGKILL');
    }
    await delay(500);
    await fsp.rm(smokeRoot, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 3, retryDelay: 250 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await smokeDesktopApp(process.argv[2], process.argv.slice(3));
}
