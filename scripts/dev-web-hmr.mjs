#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { stopChildTree, waitForSuccessfulExit } from './dev-startup.mjs';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const useDetachedChildren = process.platform !== 'win32';
const webRoot = path.join(repoRoot, 'packages/web');

function run(label, command, args, env = {}, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: useDetachedChildren,
  }).on('error', (error) => {
    console.error(`[dev:web:hmr] Failed to start ${label}:`, error);
    shutdown(1).catch(() => process.exit(1));
  });
}

const uiPort = process.env.VARIN_HMR_UI_PORT || '5180';
const backendPort = process.env.VARIN_HMR_API_PORT || '3902';
const hmrHost = process.env.VARIN_HMR_HOST || '127.0.0.1';

function getLanAddresses() {
  const addresses = [];

  for (const networkAddresses of Object.values(os.networkInterfaces())) {
    for (const address of networkAddresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      addresses.push(address.address);
    }
  }

  return addresses;
}

function clearViteCache() {
  const cacheDirs = [
    path.join(webRoot, 'node_modules/.vite'),
    path.join(webRoot, 'node_modules/.vite-temp'),
  ];

  for (const cacheDir of cacheDirs) {
    if (!existsSync(cacheDir)) continue;
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

let preparation = null;
let api = null;
let vite = null;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(preparation), stopChildTree(api), stopChildTree(vite)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) return;

    if (code !== 0 || signal) {
      console.error(`[dev:web:hmr] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});

async function start() {
  preparation = run('runtime dependencies', process.execPath, [path.join(repoRoot, 'scripts/build-products.mjs'), 'runtime']);
  await waitForSuccessfulExit(preparation, 'Runtime dependency preparation');
  preparation = null;
  if (shuttingDown) return;
  clearViteCache();

  api = run('api', 'bun', ['run', '--cwd', 'packages/web', 'dev:server:watch'], {
    VARIN_PORT: backendPort,
  });
  vite = run(
    'vite',
    'bun',
    ['x', 'vite', '--force', '--host', hmrHost, '--port', uiPort, '--strictPort'],
    {
      VARIN_PORT: backendPort,
      VARIN_DISABLE_PWA_DEV: '1',
    },
    { cwd: webRoot },
  );

  console.log(`[dev:web:hmr] UI with HMR: http://127.0.0.1:${uiPort}`);
  if (hmrHost === '0.0.0.0' || hmrHost === '::') {
    const lanAddresses = getLanAddresses();
    if (lanAddresses.length > 0) {
      for (const address of lanAddresses) {
        console.log(`[dev:web:hmr] LAN/mobile UI: http://${address}:${uiPort}`);
      }
    } else {
      console.log('[dev:web:hmr] LAN/mobile UI: no LAN IPv4 address found');
    }
  }
  console.log(`[dev:web:hmr] API: http://127.0.0.1:${backendPort}`);
  console.log('[dev:web:hmr] IMPORTANT: open UI URL above for HMR; backend URL has no HMR');
  api.on('exit', onChildExit('api'));
  vite.on('exit', onChildExit('vite'));
}

start().catch((error) => {
  if (shuttingDown) return;
  console.error('[dev:web:hmr] Startup failed:', error.message || error);
  shutdown(1).catch(() => process.exit(1));
});
