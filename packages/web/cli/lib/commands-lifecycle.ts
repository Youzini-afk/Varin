import { requestServerShutdown } from './cli-http.js';
import { isPortAvailable } from './cli-ports.js';
import {
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
} from './cli-lifecycle.js';
import {
  assertNodeServerRuntime,
  readInstanceOptions,
  removePidFile,
  removeInstanceFile,
  isProcessRunning,
  stopInstanceProcess,
} from './cli-process.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';
import { errorMessage, type CliOptions, type ServeCommand, type StopCommand } from './cli-types.js';

interface StopResult {
  pid?: number | null;
  port: number;
  reason?: string;
  runtime?: string;
  stopped: boolean;
}

const portOf = (options: CliOptions): number => (
  typeof options.port === 'number' ? options.port : 3000
);

async function stopCommand(options: CliOptions): Promise<void> {
    const showOutput = shouldRenderHumanOutput(options);
    const suppressQuietOutput = options?.suppressQuietOutput === true;
    const jsonResults: StopResult[] = [];
    const printQuietStopResults = (): void => {
      if (suppressQuietOutput) return;
      if (!isQuietMode(options) || isJsonMode(options)) return;
      if (jsonResults.length === 0) {
        process.stdout.write('none\n');
        return;
      }
      for (const result of jsonResults) {
        if (result.stopped) {
          process.stdout.write(`stopped ${result.port}\n`);
        } else {
          const reason = result.reason || 'failed';
          process.stderr.write(`failed ${result.port} ${reason}\n`);
        }
      }
    };
    const finish = (text: string): void => {
      if (!showOutput) return;
      clackOutro(text);
    };

    if (showOutput) {
      clackIntro('Varin Stop');
    }

    let runningInstances = await discoverLifecycleInstances(options);
    if (options.explicitPort) {
      if (runningInstances.length === 0) {
        const unconfirmedInstance = await discoverUnconfirmedRegistryInstanceOnPort(portOf(options), options);
        if (unconfirmedInstance) {
          runningInstances = [unconfirmedInstance];
        }
      }

      if (runningInstances.length === 0) {
        jsonResults.push({ port: portOf(options), stopped: false, reason: 'not-found' });
        if (isJsonMode(options)) {
          printJson({ stoppedCount: 0, results: jsonResults });
        }
        if (showOutput) {
          logStatus('info', `no Varin instance found on port ${portOf(options)}`);
          finish('nothing to stop');
        }
        printQuietStopResults();
        return;
      }

      const explicitInstance = runningInstances[0]!;
      if (explicitInstance.runtime === 'desktop') {
        jsonResults.push({ port: portOf(options), runtime: 'desktop', stopped: false, reason: 'desktop-managed' });
        if (isJsonMode(options)) {
          printJson({ stoppedCount: 0, results: jsonResults, messages: [{ level: 'warning', code: 'DESKTOP_MANAGED_PORT', message: `Port ${portOf(options)} is managed by Varin Desktop and cannot be stopped with this command.` }] });
        }
        if (showOutput) {
          logStatus('warning', `port ${portOf(options)} is managed by Varin Desktop`, 'cannot be stopped with this command');
          finish('no changes applied');
        }
        printQuietStopResults();
        return;
      }

      if (explicitInstance.source === 'probe') {
        const unmanagedStopSpin = showOutput ? createSpinner(options) : null;
        if (showOutput && !unmanagedStopSpin) {
          logStatus('info', `found unmanaged Varin instance on port ${portOf(options)}`, 'attempting shutdown');
        }
        unmanagedStopSpin?.start(`Stopping unmanaged Varin on port ${portOf(options)}...`);
        const requested = await requestServerShutdown(portOf(options), options.host);

        if (Number.isFinite(explicitInstance.pid) && isProcessRunning(explicitInstance.pid)) {
          await stopInstanceProcess(explicitInstance.pid, {
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          }).catch(() => false);
        }

        const stopped = await isPortAvailable(portOf(options), options.host);
        if (stopped) {
          unmanagedStopSpin?.stop(`Stopped unmanaged Varin on port ${portOf(options)}`);
          jsonResults.push({ port: portOf(options), runtime: 'unmanaged', stopped: true });
          if (isJsonMode(options)) {
            printJson({ stoppedCount: 1, results: jsonResults });
          }
          if (showOutput && !unmanagedStopSpin) {
            logStatus('success', `stopped Varin on port ${portOf(options)}`);
            finish('stop complete');
          }
          printQuietStopResults();
        } else if (requested) {
          unmanagedStopSpin?.stop(`Shutdown requested on port ${portOf(options)} (still occupied)`);
          jsonResults.push({ port: portOf(options), runtime: 'unmanaged', stopped: false, reason: 'shutdown-requested-port-busy' });
          if (isJsonMode(options)) {
            printJson({
              status: 'warning',
              stoppedCount: 0,
              results: jsonResults,
              messages: [{ level: 'warning', code: 'SHUTDOWN_PARTIAL', message: `Shutdown was requested for port ${portOf(options)}, but the port is still occupied.` }],
            });
          }
          if (showOutput && !unmanagedStopSpin) {
            logStatus('warning', `shutdown requested on port ${portOf(options)}`, 'port is still occupied');
            finish('partial stop');
          }
          printQuietStopResults();
        } else {
          unmanagedStopSpin?.error(`Could not stop Varin on port ${portOf(options)}`);
          jsonResults.push({ port: portOf(options), runtime: 'unmanaged', stopped: false, reason: 'stop-failed' });
          if (isJsonMode(options)) {
            printJson({
              status: 'error',
              stoppedCount: 0,
              results: jsonResults,
              messages: [{ level: 'error', code: 'STOP_FAILED', message: `Could not stop Varin on port ${portOf(options)}.` }],
            });
          }
          if (showOutput && !unmanagedStopSpin) {
            logStatus('error', `could not stop Varin on port ${portOf(options)}`);
            finish('failed');
          }
          printQuietStopResults();
        }
        return;
      }

      if (explicitInstance.source === 'registry-unconfirmed') {
        const unconfirmedStopSpin = showOutput ? createSpinner(options) : null;
        if (showOutput && !unconfirmedStopSpin) {
          logStatus('info', `found unconfirmed Varin pid ${explicitInstance.pid} on port ${portOf(options)}`, 'HTTP shutdown endpoint is unreachable; stopping by PID');
        }
        unconfirmedStopSpin?.start(`Stopping unconfirmed Varin on port ${portOf(options)}...`);
        const stopped = await stopInstanceProcess(explicitInstance.pid, {
          shutdownWaitMs: 0,
          gracefulTimeoutMs: 2500,
          forceTimeoutMs: 3000,
        }).catch(() => false);

        if (stopped || !isProcessRunning(explicitInstance.pid)) {
          removePidFile(explicitInstance.pidFilePath);
          removeInstanceFile(explicitInstance.instanceFilePath);
          unconfirmedStopSpin?.stop(`Stopped Varin PID ${explicitInstance.pid}`);
          jsonResults.push({ port: portOf(options), pid: explicitInstance.pid, runtime: 'unconfirmed', stopped: true });
          if (isJsonMode(options)) {
            printJson({ stoppedCount: 1, results: jsonResults });
          }
          if (showOutput && !unconfirmedStopSpin) {
            logStatus('success', `stopped pid ${explicitInstance.pid}`);
            finish('stop complete');
          }
          printQuietStopResults();
          return;
        }

        unconfirmedStopSpin?.error(`Could not stop Varin PID ${explicitInstance.pid}`);
        jsonResults.push({ port: portOf(options), pid: explicitInstance.pid, runtime: 'unconfirmed', stopped: false, reason: 'stop-failed' });
        if (isJsonMode(options)) {
          printJson({
            status: 'error',
            stoppedCount: 0,
            results: jsonResults,
            messages: [{ level: 'error', code: 'STOP_FAILED', message: `Could not stop Varin PID ${explicitInstance.pid}.` }],
          });
        }
        if (showOutput && !unconfirmedStopSpin) {
          logStatus('error', `could not stop pid ${explicitInstance.pid}`);
          finish('failed');
        }
        printQuietStopResults();
        return;
      }
    } else if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ stoppedCount: 0, results: jsonResults });
      }
      if (showOutput) {
        logStatus('info', 'No running Varin instances found');
        finish('nothing to stop');
      }
      printQuietStopResults();
      return;
    }

    for (const instance of runningInstances) {
      const stopSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !stopSpin) {
        logStatus('info', `stopping port ${instance.port} (PID: ${instance.pid})`);
      }
      stopSpin?.start(`Stopping Varin on port ${instance.port}...`);
      try {
        const requested = await requestServerShutdown(instance.port, instance.host || options.host);
        const stopped = await stopInstanceProcess(instance.pid, {
          shutdownWaitMs: requested ? 5000 : 0,
          gracefulTimeoutMs: 2500,
          forceTimeoutMs: 3000,
        });
        if (!stopped && isProcessRunning(instance.pid)) {
          throw new Error(`Timed out stopping pid ${instance.pid}`);
        }
        removePidFile(instance.pidFilePath);
        removeInstanceFile(instance.instanceFilePath);
        stopSpin?.stop(`Stopped Varin on port ${instance.port}`);
        jsonResults.push({ port: instance.port, pid: instance.pid, stopped: true });
        if (showOutput && !stopSpin) {
          logStatus('success', `stopped port ${instance.port}`);
        }
      } catch (error) {
        stopSpin?.error(`Failed to stop Varin on port ${instance.port}`);
        jsonResults.push({ port: instance.port, pid: instance.pid, stopped: false, reason: error instanceof Error ? error.message : String(error) });
        if (showOutput) {
          logStatus('error', `error stopping port ${instance.port}`, errorMessage(error));
        } else if (!isJsonMode(options) && !isQuietMode(options)) {
          console.error(`Error stopping port ${instance.port}: ${errorMessage(error)}`);
        }
      }
    }

    if (isJsonMode(options)) {
      const stoppedCount = jsonResults.filter((entry) => entry.stopped).length;
      const hasFailure = jsonResults.some((entry) => !entry.stopped);
      printJson({
        status: hasFailure ? 'warning' : 'ok',
        stoppedCount,
        results: jsonResults,
      });
      return;
    }

    finish(`${runningInstances.length} instance(s)`);
    printQuietStopResults();
}

interface LifecycleCommandContext {
  serve?: ServeCommand;
  stop?: StopCommand;
}

interface RestartResult {
  fromPort: number;
  launchMode: string;
  ok: boolean;
  toPort: number;
}

async function restartCommand(
  this: LifecycleCommandContext | void,
  options: CliOptions,
  serveCommand: ServeCommand,
): Promise<void> {
    const commandContext: LifecycleCommandContext = this && typeof this === 'object' ? this : {};
    const runStop = typeof commandContext.stop === 'function'
      ? commandContext.stop.bind(commandContext)
      : stopCommand;
    const runServe = typeof commandContext.serve === 'function'
      ? commandContext.serve.bind(commandContext)
      : serveCommand;
    const showOutput = shouldRenderHumanOutput(options);
    const restarted: RestartResult[] = [];

    if (showOutput) {
      clackIntro('Varin Restart');
    }

    const runningInstances = await discoverLifecycleInstances(options);
    if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ restartedCount: 0, results: restarted });
      }
      if (showOutput) {
        logStatus('info', 'No running Varin instances to restart');
        clackOutro('nothing to restart');
      } else if (isQuietMode(options)) {
        process.stdout.write('restarted 0\n');
      }
      return;
    }

    for (const instance of runningInstances) {
      if (instance.runtime === 'desktop') {
        const message = `Port ${instance.port} is managed by Varin Desktop and cannot be restarted with this command.`;
        if (isJsonMode(options)) {
          printJson({
            status: 'warning',
            restartedCount: 0,
            results: [{ fromPort: instance.port, runtime: 'desktop', ok: false, reason: 'desktop-managed' }],
            messages: [{ level: 'warning', code: 'DESKTOP_MANAGED_PORT', message }],
          });
          return;
        }
        if (showOutput) {
          logStatus('warning', `port ${instance.port} is managed by Varin Desktop`, 'cannot be restarted with this command');
          clackOutro('no changes applied');
        } else if (isQuietMode(options)) {
          process.stdout.write('restarted 0\n');
        }
        return;
      }

      const storedOptions = instance.instanceFilePath
        ? (readInstanceOptions(instance.instanceFilePath) || { port: instance.port })
        : { port: instance.port };
      const instanceHost = storedOptions.host || instance.host || options.host;
      const launchMode = instance.launchMode || 'daemon';
      const isForeground = launchMode === 'foreground';
      if (!isForeground) assertNodeServerRuntime();

      const restartPort = options.explicitPort && typeof portOf(options) === 'number' ? portOf(options) : instance.port;

      const restartSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !restartSpin) {
        logStatus('info', `restarting port ${instance.port}`, `mode: ${launchMode}`);
      }
      restartSpin?.start(`Restarting Varin on port ${instance.port}...`);
      try {
        await runStop({
          explicitPort: true,
          port: instance.port,
          host: instanceHost,
          quiet: true,
          suppressQuietOutput: true,
        });

        // Foreground instances are managed by a process manager (systemd,
        // Docker, etc.) that will restart them automatically after stop.
        // Do not call serve() here — just record the stop as a successful
        // restart and let the process manager handle the actual restart.
        if (isForeground) {
          restarted.push({ fromPort: instance.port, toPort: restartPort, launchMode, ok: true });
          restartSpin?.stop(`Stopped foreground instance on port ${instance.port} (process manager will restart)`);
          if (showOutput && !restartSpin) {
            logStatus('success', `port ${instance.port} stopped`, 'process manager will restart');
          }
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));

        const restartedPort = await runServe({
          port: restartPort,
          host: instanceHost,
          explicitPort: true,
          uiPassword: options.explicitUiPassword ? options.uiPassword : (storedOptions.uiPassword || options.uiPassword),
          apiOnly: storedOptions.apiOnly === true || options.apiOnly === true,
          suppressStartupSummary: true,
          quiet: true,
          suppressUiPasswordWarning: true,
          suppressQuietOutput: true,
        });
        if (typeof restartedPort !== 'number') throw new Error('Varin serve did not return a port');
        restarted.push({ fromPort: instance.port, toPort: restartedPort, launchMode, ok: true });
        restartSpin?.stop(`Restarted Varin on port ${restartedPort}`);
        if (showOutput && !restartSpin) {
          logStatus('success', `port ${restartedPort} restarted`, `mode: ${launchMode}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        restartSpin?.error(`Failed to restart Varin on port ${instance.port}`);
        if (showOutput && !restartSpin) {
          logStatus('error', `failed to restart port ${instance.port}`, message);
        }
        throw error;
      }
    }

    if (isJsonMode(options)) {
      printJson({ restartedCount: restarted.length, results: restarted.map((r) => ({ ...r, launchMode: r.launchMode })) });
      return;
    }

    if (showOutput) {
      clackOutro(`${runningInstances.length} instance(s) restarted`);
    } else if (isQuietMode(options)) {
      process.stdout.write(`restarted ${restarted.length}\n`);
    }
}

function createLifecycleCommands({ serveCommand }: { serveCommand: ServeCommand }): {
  restart: (options: CliOptions) => Promise<void>;
  stop: StopCommand;
} {
  return {
    stop: stopCommand,
    restart(options) {
      return restartCommand.call(this, options, serveCommand);
    },
  };
}

export { createLifecycleCommands };
