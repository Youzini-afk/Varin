#!/usr/bin/env node
/**
 * Varin local development helper.
 *
 * This script owns the interactive `bun run varin-dev` menu and the equivalent
 * non-interactive commands for common local workflows: web deploys, mobile
 * builds/device deploys, Electron, and maintainer release tasks.
 *
 * Personal or machine-specific options are intentionally kept out of git.
 * The only supported user config is:
 *
 *   ~/.config/varin/varin-dev.json
 *
 * See `scripts/varin-dev.config.example.json` for the shape. The config can set
 * local device/app preferences such as `ios.deviceName`, `ios.useXcodeBeta`,
 * and `ios.xcodeAppName`, and can define `remoteDeployments`. Remote deploy
 * menu entries are shown only when configured. Maintainer-only actions such as
 * release creation are hidden unless `features.releaseTools` is true.
 *
 * Menus are platform-aware: macOS-only iOS/Xcode actions are hidden off macOS.
 * Direct unsupported commands fail with a clear error instead of relying on
 * prompts for safety.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, intro, isCancel, log, outro, select, text } from '@clack/prompts';
import { installCloudRuntimeDependencies } from './build-cloud-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(os.homedir(), '.config', 'varin', 'varin-dev.json');

const GLOBAL_PORT = '2606';
const TESTING_PORT = '1202';
const REMOTE_RUNTIME_ENV = 'PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH';
const localRuntimeRoot = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Varin', 'DevRuntimes')
  : path.join(os.homedir(), '.local', 'share', 'varin', 'dev-runtimes');
const localRuntimeCache = path.join(localRuntimeRoot, '.bun-cache');

const isTty = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
const isMac = process.platform === 'darwin';

function printHelp() {
  console.log(`Usage:
  bun run varin-dev [action] [options]
  node scripts/varin-dev.mjs [action] [options]

Actions:
  build-deploy-web                 Build and deploy a local cloud runtime
  remote-deploy-web                Atomically deploy to a configured remote target
  start-web-dev                    Start web development loop
  start-mobile-dev                 Start mobile app with dev server live reload
  mobile-tools                     Mobile build/sync/deploy helper menu
  start-electron-app               Start Electron app in dev mode
  build-electron-app               Build Electron app artifacts
  create-release                   Validate and bump release version

Options:
  -a, --action <action>
  --deployment-mode <local|testing>
  --remote-id <id>                 Remote deployment id from ${configPath}
  --target <test-api|test-ui>      Select a remote deployment by surface
  --web-mode <hmr|hmr-react-scan|hmr-lan|full>
  --mobile-mode <ios-sim-local|ios-sim-lan|android-local|android-lan>
  --mobile-task <task>
  --adb-address <host:port>        Wireless ADB address for android-connect
  --version <semver>
  -h, --help

Mobile tasks:
  build, sync, android-devices, android-connect, android-deploy-usb, android-run, android-logcat,
  ios-sim-build, ios-sim-run, ios-sim-serve, ios-sim-kill, ios-device-sync-debug
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-a':
      case '--action':
        options.action = readValue();
        break;
      case '--deployment-mode':
        options.deploymentMode = readValue();
        break;
      case '--remote-id':
        options.remoteId = readValue();
        break;
      case '--target':
        options.target = readValue();
        break;
      case '--web-mode':
        options.webMode = readValue();
        break;
      case '--mobile-mode':
        options.mobileMode = readValue();
        break;
      case '--mobile-task':
        options.mobileTask = readValue();
        break;
      case '--adb-address':
        options.adbAddress = readValue();
        break;
      case '--version':
        options.version = readValue();
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        if (options.action) throw new Error(`Unexpected argument: ${arg}`);
        options.action = arg;
        break;
    }
  }
  return options;
}

function loadConfig() {
  if (!existsSync(configPath)) return { remoteDeployments: [] };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      ...parsed,
      remoteDeployments: Array.isArray(parsed.remoteDeployments) ? parsed.remoteDeployments : [],
    };
  } catch (error) {
    throw new Error(`Failed to read ${configPath}: ${error.message}`);
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: options.shell || false,
  });
  if (result.status !== 0 && !options.allowFail) {
    if (options.capture) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${options.label || [command, ...args].join(' ')} failed`);
  }
  return result.stdout?.trim() || '';
}

function step(label, fn) {
  log.step(label);
  const result = fn();
  log.success(`${label} completed`);
  return result;
}

function printReleaseNextSteps(version) {
  log.success(`Release v${version} prepared locally`);
  log.info('Next steps:');
  console.log(`  git add -A`);
  console.log(`  git commit -m "release v${version}"`);
  console.log(`  git tag v${version}`);
  console.log(`  git push origin main --tags`);
  console.log('');
  console.log('This will trigger the GitHub Actions release workflow.');
  console.log(`Make sure CHANGELOG.md contains a section like "## [${version}] - YYYY-MM-DD" before pushing.`);
}

function normalizeAction(action = '') {
  const normalized = action.toLowerCase();
  const aliases = {
    'deploy-web': 'build-deploy-web',
    'build/deploy-web': 'build-deploy-web',
    'web-dev': 'start-web-dev',
    'mobile-dev': 'start-mobile-dev',
    'ios-sim-dev': 'start-mobile-dev',
    mobile: 'mobile-tools',
    'mobile-menu': 'mobile-tools',
    'remote-deploy-web': 'remote-deploy-web',
    'electron-dev': 'start-electron-app',
    'electron-build': 'build-electron-app',
    release: 'create-release',
  };
  return aliases[normalized] || normalized;
}

function ensurePromptable() {
  if (!isTty) throw new Error('Missing required option and no TTY is available for prompting.');
}

async function chooseValue(current, choices, message) {
  if (current) return current;
  ensurePromptable();
  const value = await select({ message, options: choices });
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    process.exit(130);
  }
  return value;
}

async function chooseText(current, message, placeholder) {
  if (current) return current;
  ensurePromptable();
  const value = await text({ message, placeholder });
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    process.exit(130);
  }
  return value;
}

function validateAdbAddress(address) {
  const normalized = String(address || '').trim();
  if (!/^[^\s:]+:\d{1,5}$/.test(normalized)) {
    throw new Error('Invalid wireless ADB address. Use host:port, e.g. 192.168.1.139:38181');
  }
  const port = Number(normalized.split(':').at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid wireless ADB port. Use a port between 1 and 65535.');
  }
  return normalized;
}

function detectLanIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '';
}

function latestFileByExtensions(directory, extensions) {
  if (!existsSync(directory)) return '';
  return readdirSync(directory)
    .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
    .map((entry) => {
      const filePath = path.join(directory, entry);
      return { filePath, mtimeMs: statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath || '';
}

function installedRuntimeCli(directory) {
  const cliPath = path.join(directory, 'packages', 'web', 'bin', 'cli.js');
  return existsSync(cliPath) ? cliPath : '';
}

function stopInstalledInstance(directory, port) {
  const cliPath = installedRuntimeCli(directory);
  if (!cliPath) return;
  run('node', [cliPath, 'stop', '--port', port], { cwd: directory, allowFail: true, label: `stop instance on ${port}` });
}

function startInstalledInstance(directory, port) {
  const cliPath = installedRuntimeCli(directory);
  if (!cliPath) throw new Error(`Varin CLI was not installed in ${directory}`);
  run('node', [cliPath, 'serve', '--port', port, '--host', process.env.VARIN_HOST || '127.0.0.1'], {
    cwd: directory,
    env: {
      VARIN_UI_PASSWORD: process.env.VARIN_UI_PASSWORD || '',
      VARIN_HOST: process.env.VARIN_HOST || '127.0.0.1',
    },
    label: `start instance on ${port}`,
  });
}

function installedRuntimeVersion(directory) {
  try {
    const metadataPath = path.join(directory, 'cloud-runtime.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    return typeof metadata.version === 'string' ? metadata.version : '';
  } catch {
    return '';
  }
}

function waitForInstalledInstance(directory, port, expectedVersion) {
  const bindHost = process.env.VARIN_HOST || '127.0.0.1';
  const probeHost = bindHost === '0.0.0.0'
    ? '127.0.0.1'
    : bindHost === '::'
      ? '::1'
      : bindHost;
  const urlHost = probeHost.includes(':') ? `[${probeHost.replace(/^\[|\]$/g, '')}]` : probeHost;
  run('node', [
    '--input-type=module',
    '-e',
    `
      const deadline = Date.now() + 45_000;
      let lastError = 'no response';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(process.env.VARIN_LOCAL_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
          const body = await response.json();
          if (response.ok && body.status === 'ok' && body.varinVersion === process.env.VARIN_EXPECTED_VERSION && body.kernel?.ready === true) process.exit(0);
          lastError = \`status=\${response.status} body=\${JSON.stringify(body)}\`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      console.error(\`Varin local health check timed out: \${lastError}\`);
      process.exit(1);
    `,
  ], {
    cwd: directory,
    env: {
      VARIN_LOCAL_HEALTH_URL: `http://${urlHost}:${port}/health`,
      VARIN_EXPECTED_VERSION: expectedVersion,
    },
    label: `wait for Varin ${expectedVersion} on ${port}`,
  });
}

function parseCloudRuntimeMetadata(output) {
  const line = output.split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error('Cloud runtime builder did not return metadata.');
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Cloud runtime builder returned invalid metadata: ${error.message}`);
  }
}

function buildCloudRuntime({ outputDir, archivePath, install = false }) {
  const args = [
    'scripts/build-cloud-runtime.mjs',
    '--output', outputDir,
    '--cache-dir', localRuntimeCache,
    '--json',
  ];
  if (archivePath) args.push('--archive', archivePath);
  else args.push('--no-archive');
  if (install) args.push('--install');
  const output = run('node', args, { capture: true, label: 'build Varin cloud runtime' });
  return parseCloudRuntimeMetadata(output);
}

function packageCloudRuntime() {
  const outputDir = path.join(repoRoot, 'artifacts', 'cloud-runtime');
  const archivePath = path.join(repoRoot, 'artifacts', 'varin-cloud-runtime.tgz');
  const metadata = step('Building Varin cloud runtime archive', () => buildCloudRuntime({
    outputDir,
    archivePath,
  }));
  if (!metadata.archivePath || !metadata.archiveSha256) {
    throw new Error('Cloud runtime archive metadata is incomplete.');
  }
  return metadata;
}

function deployLocalRuntime(targetDirectory, port) {
  const stagingDirectory = `${targetDirectory}.staging-${process.pid}`;
  const previousDirectory = `${targetDirectory}.previous`;
  rmSync(stagingDirectory, { recursive: true, force: true });
  let metadata;
  try {
    metadata = step('Building Varin runtime tree', () => buildCloudRuntime({
      outputDir: stagingDirectory,
    }));
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  let previousMoved = false;
  let previousStopped = false;
  let candidateActivated = false;
  try {
    rmSync(previousDirectory, { recursive: true, force: true });
    if (existsSync(targetDirectory)) {
      stopInstalledInstance(targetDirectory, port);
      previousStopped = true;
      renameSync(targetDirectory, previousDirectory);
      previousMoved = true;
    }
    renameSync(stagingDirectory, targetDirectory);
    candidateActivated = true;
    step('Installing target-platform Varin dependencies', () => installCloudRuntimeDependencies(
      targetDirectory,
      { cacheDir: localRuntimeCache },
    ));
    startInstalledInstance(targetDirectory, port);
    waitForInstalledInstance(targetDirectory, port, metadata.version);
  } catch (error) {
    let rollbackError;
    if (candidateActivated) {
      stopInstalledInstance(targetDirectory, port);
      rmSync(targetDirectory, { recursive: true, force: true });
    }
    if (previousMoved && existsSync(previousDirectory)) {
      renameSync(previousDirectory, targetDirectory);
      try {
        startInstalledInstance(targetDirectory, port);
        waitForInstalledInstance(targetDirectory, port, installedRuntimeVersion(targetDirectory));
      } catch (restartError) {
        rollbackError = restartError;
      }
    } else if (previousStopped && existsSync(targetDirectory)) {
      try {
        startInstalledInstance(targetDirectory, port);
        waitForInstalledInstance(targetDirectory, port, installedRuntimeVersion(targetDirectory));
      } catch (restartError) {
        rollbackError = restartError;
      }
    }
    rmSync(stagingDirectory, { recursive: true, force: true });
    if (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Varin candidate failed and the previous local runtime could not be restored.');
    }
    throw error;
  }

  log.success(`Varin ${metadata.version} local runtime ready on port ${port}`);
}

async function selectRemoteDeployment(config, options) {
  if (options.remoteId) {
    const remote = config.remoteDeployments.find((entry) => entry.id === options.remoteId);
    if (!remote) throw new Error(`No remote deployment with id "${options.remoteId}" in ${configPath}`);
    return remote;
  }

  if (options.target) {
    const normalizedTarget = options.target.toLowerCase();
    const apiOnly = ['test', 'testing', 'test-api', 'api', 'api-only'].includes(normalizedTarget);
    const withUi = ['test-ui', 'ui', 'with-ui'].includes(normalizedTarget);
    if (!apiOnly && !withUi) throw new Error('Invalid --target. Use test-api or test-ui.');
    const remote = config.remoteDeployments.find((entry) => Boolean(entry.apiOnly) === apiOnly || (!entry.apiOnly && withUi));
    if (remote) return remote;
  }

  if (config.remoteDeployments.length === 0) {
    throw new Error(`No remoteDeployments configured in ${configPath}`);
  }

  return chooseValue(
    '',
    config.remoteDeployments.map((remote) => ({ value: remote.id, label: remote.label || remote.id, hint: `${remote.host}:${remote.port}` })),
    'Select remote deployment',
  ).then((id) => config.remoteDeployments.find((entry) => entry.id === id));
}

async function deployWeb(options, config) {
  const deploymentMode = (await chooseValue(options.deploymentMode, [
    { value: 'local', label: 'Local runtime' },
    { value: 'testing', label: 'Testing' },
  ], 'Select installation mode')).toLowerCase();

  if (!['local', 'testing'].includes(deploymentMode)) {
    throw new Error('Invalid deployment mode. Use local or testing. Use remote-deploy-web for configured remote deployments.');
  }

  if (deploymentMode === 'testing') {
    deployLocalRuntime(path.join(localRuntimeRoot, 'testing'), TESTING_PORT);
    return;
  }

  deployLocalRuntime(path.join(localRuntimeRoot, 'local'), GLOBAL_PORT);
}

async function deployRemoteWeb(options, config) {
  const remote = await selectRemoteDeployment(config, options);
  const metadata = packageCloudRuntime();
  const host = remote.host;
  const dir = String(remote.dir || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const port = String(remote.port);
  const bindHost = String(remote.bindHost || '0.0.0.0');
  const archiveBase = `varin-cloud-runtime-${metadata.archiveSha256.slice(0, 16)}.tgz`;
  const deployScriptBase = 'deploy-cloud-runtime.sh';
  const releaseId = `${metadata.version}-${metadata.archiveSha256.slice(0, 16)}`;

  if (!host || !dir || !port) throw new Error(`Remote deployment ${remote.id} must define host, dir, and port.`);
  if (!/^[A-Za-z0-9._/-]+$/.test(dir) || dir.startsWith('/') || dir.split('/').includes('..')) {
    throw new Error(`Remote deployment ${remote.id} has an unsafe relative dir: ${dir}`);
  }
  if (String(host).startsWith('-') || /\s/.test(String(host))) {
    throw new Error(`Remote deployment ${remote.id} has an invalid SSH host: ${host}`);
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`Remote deployment ${remote.id} has an invalid port: ${port}`);
  }

  step('Preparing remote Varin incoming directory', () => run('ssh', [
    host,
    `mkdir -p "$HOME/${dir}/incoming"`,
  ]));
  step('Uploading immutable Varin cloud runtime', () => {
    run('scp', ['-q', metadata.archivePath, `${host}:~/${dir}/incoming/${archiveBase}`]);
    run('scp', ['-q', path.join(repoRoot, 'scripts', 'deploy-cloud-runtime.sh'), `${host}:~/${dir}/incoming/${deployScriptBase}`]);
  });

  const deployArgs = [
    `${REMOTE_RUNTIME_ENV}; bash "$HOME/${dir}/incoming/${deployScriptBase}"`,
    '--root', quote(dir),
    '--archive', quote(`incoming/${archiveBase}`),
    '--sha256', quote(metadata.archiveSha256),
    '--release-id', quote(releaseId),
    '--port', quote(port),
    '--bind-host', quote(bindHost),
  ];
  if (remote.dataDir) deployArgs.push('--data-dir', quote(remote.dataDir));
  if (remote.envFile) deployArgs.push('--env-file', quote(remote.envFile));
  if (remote.healthTimeoutSeconds) deployArgs.push('--health-timeout', quote(remote.healthTimeoutSeconds));
  if (remote.apiOnly) deployArgs.push('--api-only');

  step(`Deploying Varin ${metadata.version} to ${host}:${port}`, () => run('ssh', [host, deployArgs.join(' ')]));
  log.success(`Remote Varin ${metadata.version} is healthy: ${host}:${port}`);
}

async function startWebDev(options) {
  const mode = await chooseValue(options.webMode, [
    { value: 'hmr', label: 'Web HMR' },
    { value: 'hmr-react-scan', label: 'Web HMR + React Scan' },
    { value: 'hmr-lan', label: 'Web HMR LAN/mobile' },
    { value: 'full', label: 'Web prod-like' },
  ], 'Select web dev mode');

  if (mode === 'hmr-react-scan') {
    run('bun', ['run', 'dev:web:hmr'], { env: { VITE_ENABLE_REACT_SCAN: '1' } });
  } else if (mode === 'hmr-lan') {
    log.info('Starting web HMR LAN/mobile loop. Open the LAN URL printed after startup.');
    run('bun', ['run', 'dev:web:hmr'], { env: { VARIN_HMR_HOST: '0.0.0.0' } });
  } else if (mode === 'full') {
    run('bun', ['run', 'dev:web:full']);
  } else {
    run('bun', ['run', 'dev:web:hmr']);
  }
}

async function startMobileDev(options) {
  const mobileModeChoices = [
    { value: 'ios-sim-local', label: 'iOS Simulator local' },
    { value: 'ios-sim-lan', label: 'iOS Simulator LAN' },
    { value: 'android-local', label: 'Android emulator local' },
    { value: 'android-lan', label: 'Android device LAN' },
  ].filter((choice) => isMac || !choice.value.startsWith('ios-'));
  const mode = await chooseValue(options.mobileMode, mobileModeChoices, 'Select mobile dev mode');

  if (mode.startsWith('ios-') && !isMac) {
    throw new Error('iOS mobile dev actions require macOS and Xcode.');
  }

  const hmrPort = process.env.VARIN_HMR_UI_PORT || '5180';
  let hmrBindHost = '127.0.0.1';
  let liveReloadHost = '127.0.0.1';
  let platform = 'ios';
  let extraArgs = [];

  if (mode === 'ios-sim-lan' || mode === 'android-lan') {
    hmrBindHost = '0.0.0.0';
    liveReloadHost = detectLanIp();
    if (!liveReloadHost) throw new Error('Could not detect LAN IP.');
  }
  if (mode.startsWith('android')) platform = 'android';
  if (mode === 'android-local') extraArgs = ['--forwardPorts', `${hmrPort}:${hmrPort}`];

  log.step(`Starting mobile UI dev server on ${hmrBindHost}:${hmrPort}`);
  const devServer = spawn('bun', ['x', 'vite', '--config', 'local-dev-mobile-vite.config.mjs', '--host', hmrBindHost, '--port', hmrPort, '--strictPort'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, VARIN_DISABLE_PWA_DEV: '1' },
  });

  const stopDevServer = () => {
    if (!devServer.killed) devServer.kill('SIGTERM');
  };
  process.once('SIGINT', () => {
    stopDevServer();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stopDevServer();
    process.exit(143);
  });

  await new Promise((resolve) => setTimeout(resolve, 6000));
  run('node', ['scripts/with-mobile-env.mjs', `bunx cap run ${platform} --live-reload --host ${liveReloadHost} --port ${hmrPort} ${extraArgs.join(' ')}`], { cwd: path.join(repoRoot, 'packages/mobile') });
  log.info('Mobile UI dev server is still running. Press Ctrl+C to stop.');
  await new Promise((resolve) => devServer.on('exit', resolve));
}

async function mobileTools(options, config) {
  const mobileTaskChoices = [
    { value: 'build', label: 'Build mobile web assets' },
    { value: 'sync', label: 'Sync native projects' },
    { value: 'android-devices', label: 'Android: list USB devices' },
    { value: 'android-connect', label: 'Android: connect wireless ADB device' },
    { value: 'android-deploy-usb', label: 'Android: rebuild + deploy to USB device' },
    { value: 'android-run', label: 'Android: install + launch existing APK' },
    { value: 'android-logcat', label: 'Android: logcat' },
    { value: 'ios-sim-build', label: 'iOS Simulator: build' },
    { value: 'ios-sim-run', label: 'iOS Simulator: install + launch' },
    { value: 'ios-sim-serve', label: 'iOS Simulator: browser preview' },
    { value: 'ios-sim-kill', label: 'iOS Simulator: stop browser preview' },
    { value: 'ios-device-sync-debug', label: 'iOS Device: sync + open debugger workspace' },
  ].filter((choice) => isMac || !choice.value.startsWith('ios-'));
  const task = await chooseValue(options.mobileTask, mobileTaskChoices, 'Select mobile action');

  if (task.startsWith('ios-') && !isMac) {
    throw new Error('iOS mobile actions require macOS and Xcode.');
  }

  const mobileCwd = path.join(repoRoot, 'packages/mobile');
  const mobileRun = (label, script) => step(label, () => run('bun', ['run', script], { cwd: mobileCwd }));
  switch (task) {
    case 'build': return mobileRun('Building mobile web assets', 'build');
    case 'sync': return mobileRun('Syncing native projects', 'sync');
    case 'android-devices': return mobileRun('Listing Android USB devices', 'android:devices');
    case 'android-connect': {
      const address = validateAdbAddress(await chooseText(options.adbAddress, 'Enter wireless ADB address', '192.168.1.139:38181'));
      step(`Connecting wireless ADB device at ${address}`, () => run('node', ['scripts/with-mobile-env.mjs', `adb connect ${quote(address)}`], { cwd: mobileCwd }));
      return mobileRun('Listing Android devices', 'android:devices');
    }
    case 'android-deploy-usb':
      mobileRun('Building Android debug APK', 'build:android:debug');
      return mobileRun('Installing and launching Android app on USB device', 'android:run');
    case 'android-run': return mobileRun('Installing and launching Android app on USB device', 'android:run');
    case 'android-logcat': return mobileRun('Streaming Android app logs', 'android:logcat');
    case 'ios-sim-build': return mobileRun('Building iOS Simulator app', 'build:ios:simulator');
    case 'ios-sim-run': return mobileRun('Installing and launching iOS Simulator app', 'sim:run');
    case 'ios-sim-serve': return mobileRun('Starting iOS Simulator browser preview', 'sim:serve');
    case 'ios-sim-kill': return mobileRun('Stopping iOS Simulator browser preview', 'sim:kill');
    case 'ios-device-sync-debug': {
      mobileRun('Syncing iOS native project', 'sync');
      const deviceName = process.env.IOS_DEVICE_NAME || config.ios?.deviceName || 'iPhone Bohdan';
      const xcodeAppName = process.env.XCODE_APP_NAME || config.ios?.xcodeAppName || (config.ios?.useXcodeBeta ? 'Xcode-beta' : 'Xcode');
      log.info(`Target physical device: ${deviceName}`);
      log.warn('CLI can sync/build/install parts of iOS, but attaching Apple\'s debugger to a physical iPhone is still Xcode\'s job. Select the device in Xcode and press Run.');
      if (process.platform !== 'darwin') throw new Error('Opening Xcode requires macOS.');
      return step(`Opening iOS workspace in ${xcodeAppName}`, () => run('open', ['-a', xcodeAppName, path.join(mobileCwd, 'ios/App/App.xcworkspace')]));
    }
    default:
      throw new Error(`Unknown mobile task: ${task}`);
  }
}

function startElectronApp() {
  run('bun', ['run', 'electron:dev']);
}

function buildElectronApp() {
  run('bun', ['run', 'electron:build'], { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  const distDir = path.join(repoRoot, 'packages/electron/dist');
  if (!existsSync(distDir) || !isMac) return;
  const artifact = latestFileByExtensions(distDir, ['.dmg', '-mac.zip']);
  if (artifact) run('open', [artifact]);
}

async function createRelease(options) {
  if (!options.config?.features?.releaseTools) {
    throw new Error(`Release tools are disabled. Set features.releaseTools=true in ${configPath} to enable this maintainer task.`);
  }

  let version = options.version;
  if (!version) {
    ensurePromptable();
    version = await text({ message: 'Enter release version', placeholder: '1.4.7' });
    if (isCancel(version)) {
      cancel('Operation cancelled.');
      process.exit(130);
    }
  }
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) throw new Error('Invalid version format. Use semver, e.g. 1.4.7 or 1.4.7-beta.1');
  step('Validating codebase', () => run('bun', ['run', 'release:prepare']));
  step(`Bumping version to ${version}`, () => run('node', ['scripts/bump-version.mjs', version]));
  printReleaseNextSteps(version);
}

async function chooseAction(config) {
  const options = [
    { value: 'build-deploy-web', label: 'Build/Deploy web' },
    { value: 'start-web-dev', label: 'Start web dev' },
    { value: 'start-mobile-dev', label: 'Start mobile dev' },
    { value: 'mobile-tools', label: 'Mobile tools' },
    { value: 'start-electron-app', label: 'Start Electron app' },
    { value: 'build-electron-app', label: 'Build Electron app' },
  ];

  if (config.features?.releaseTools) {
    options.push({ value: 'create-release', label: 'Create Release' });
  }
  if (config.remoteDeployments.length > 0) {
    options.splice(1, 0, { value: 'remote-deploy-web', label: 'Deploy configured remote web' });
  }
  const action = await chooseValue('', options, 'Select Varin dev action');
  return action;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const interactive = !options.action;
  if (interactive) intro('Varin dev');
  let action = normalizeAction(options.action || await chooseAction(config));

  switch (action) {
    case 'build-deploy-web':
      await deployWeb(options, config);
      break;
    case 'remote-deploy-web':
      await deployRemoteWeb(options, config);
      break;
    case 'start-web-dev':
      await startWebDev(options);
      break;
    case 'start-mobile-dev':
      await startMobileDev(options);
      break;
    case 'mobile-tools':
      await mobileTools(options, config);
      break;
    case 'start-electron-app':
      startElectronApp();
      break;
    case 'build-electron-app':
      buildElectronApp();
      break;
    case 'create-release':
      options.config = config;
      await createRelease(options);
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  if (interactive) outro('Done');
}

main().catch((error) => {
  log.error(error.message);
  process.exit(1);
});
