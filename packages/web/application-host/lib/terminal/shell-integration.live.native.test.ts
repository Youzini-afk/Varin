import { existsSync, readlinkSync } from "node:fs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedTerminalSessionApi } from "./isolated-session-api.test-helper.js";
import type { TerminalCommandRecord } from "./session-api.js";
import { createPlatformEnvironmentRuntime } from '../platform/environment-runtime.js';
import { createNativeProcessTestHarness, hasNativeProcessKernel, type NativeProcessDiagnostic } from '../process/native-process.test-helper.js';

const gitBashCandidates = [
  process.env.VARIN_TERMINAL_SHELL,
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
].filter((value): value is string => typeof value === "string" && value.length > 0);

const powershellPath = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const resolveLiveShell = (): { family: "bash" | "powershell"; path: string; shell: "bash" | "powershell" } | null => {
  for (const candidate of gitBashCandidates) {
    if (existsSync(candidate) && /bash/i.test(candidate)) {
      return { family: "bash", path: candidate, shell: "bash" };
    }
  }
  if (existsSync(powershellPath)) {
    return { family: "powershell", path: powershellPath, shell: "powershell" };
  }
  return null;
};

const liveShell = resolveLiveShell();
const storeAlias = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe');
let storePowerShell: string | undefined;
try { storePowerShell = process.platform === 'win32' ? readlinkSync(storeAlias) : undefined; } catch { /* Store PowerShell is optional. */ }

describe("live shell integration", () => {
  it.skipIf(!storePowerShell || !hasNativeProcessKernel)('discovers Store PowerShell and runs a Unicode command through the native user terminal', async () => {
    const previous = process.env.VARIN_TERMINAL_SHELL;
    process.env.VARIN_TERMINAL_SHELL = storeAlias;
    const platform = createPlatformEnvironmentRuntime();
    const runtime = createIsolatedTerminalSessionApi({ isExecutable: platform.isExecutable,
      searchPathFor: platform.searchPathFor, buildAugmentedPath: () => path.dirname(storeAlias) });
    const commands: TerminalCommandRecord[] = [];
    const observation = runtime.subscribeCommands(command => commands.push(command));
    try {
      const handle = await runtime.createTerminalSession({ sessionId: 'store-pwsh', cwd: tmpdir(), owner: 'user', shell: 'pwsh' });
      let output = '';
      const data = handle.onData(text => { output += text; });
      await vi.waitFor(() => expect(runtime.inspectSession(handle.id)?.integration).toBe('ready'), { timeout: 15_000 });
      await handle.write("Write-Output '中文🙂'\r".repeat(2));
      await vi.waitFor(() => expect(commands.filter(command => command.command.includes('中文🙂') && command.exitCode === 0)).toHaveLength(2), { timeout: 15_000 });
      expect(output).toContain('中文🙂');
      data.dispose();
      await handle.destroy();
    } finally {
      observation.dispose();
      try { await runtime.shutdown(); }
      finally { if (previous === undefined) delete process.env.VARIN_TERMINAL_SHELL; else process.env.VARIN_TERMINAL_SHELL = previous; }
    }
  }, 35_000);
  it.skipIf(!liveShell)("observes a real user-terminal command on Windows Git Bash or PowerShell", async () => {
    const shell = liveShell!;
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'varin-live-shell-'));
    const started = performance.now();
    const phase = (name: string) => console.info(`[live shell] ${name}: ${Math.round(performance.now() - started)}ms`);
    // Avoid diagnostic console I/O between the observed command and native stop.
    const nativePhases: Array<{ name: string; atMs: number }> = [];
    const nativePhase = (name: string) => { nativePhases.push({ name, atMs: Math.round(performance.now() - started) }); };
    const nativeStages: NativeProcessDiagnostic[] = [];
    let reportPendingStages = false;
    // Stage-frame writes can perturb teardown scheduling. Normal acceptance
    // must use the production path; opt in only for a targeted investigation.
    const onProcessDiagnostic = process.env.VARIN_TEST_TERMINAL_TRACE === '1' ? (event: NativeProcessDiagnostic) => {
      nativeStages.push(event);
      // Once the original teardown is already stalled, retain visibility of
      // later progress without console I/O in the command-to-stop race window.
      if (reportPendingStages) console.info('[live shell] pending native stage', event);
    } : undefined;
    const native = createNativeProcessTestHarness(undefined, onProcessDiagnostic ? { onProcessDiagnostic } : {
      stalledProcessDiagnostics: process.env.VARIN_TEST_TERMINAL_TRACE === 'stalled',
    });
    let lastControl: Record<string, unknown> | undefined;
    let lastData: Record<string, unknown> | undefined;
    let nativeRoot: string | undefined;
    const runtime = createIsolatedTerminalSessionApi({
      loadPtyProvider: async () => {
        const { service, client, root } = await native.get();
        nativeRoot = root;
        const subscribe = client.processSubscribe.bind(client);
        client.processSubscribe = (params, grant, observer) => {
          const pending = subscribe(params, grant, (event, acknowledge) => {
            const result = event.result;
            if (result) {
              const metadata = {
                atMs: Math.round(performance.now() - started), sequence: event.sequence,
                processId: result.process?.processId,
                status: result.process?.status, writerActive: result.process?.writerActive,
                exitCode: result.process?.exitCode, outputComplete: result.outputComplete,
                outputError: result.outputError, nextCursor: result.nextCursor, endCursor: result.endCursor,
              };
              if (event.stream === 'control') lastControl = metadata;
              else lastData = metadata;
            }
            observer(event, acknowledge);
          });
          void pending.then(subscription => {
            const close = subscription.close;
            subscription.close = () => {
              nativePhase('subscription close requested');
              const closing = close();
              void closing.then(() => nativePhase('subscription close acknowledged'), () => nativePhase('subscription close rejected'));
              return closing;
            };
          }, () => nativePhase('subscription rejected'));
          return pending;
        };
        const release = client.processRelease.bind(client);
        client.processRelease = (...args) => {
          nativePhase('native release requested');
          const pending = release(...args);
          void pending.then(() => nativePhase('native release acknowledged'), () => nativePhase('native release rejected'));
          return pending;
        };
        const provider = service.ptyProvider;
        return { ...provider, async spawn(...args: Parameters<typeof provider.spawn>) {
          const process = await provider.spawn(...args);
          process.onExit(() => nativePhase('native exit delivered'));
          void process.completion.then(() => nativePhase('native completion'), () => nativePhase('native completion rejected'));
          const terminate = process.terminate;
          process.terminate = (force = false) => {
            nativePhase('native stop requested');
            const pending = terminate(force);
            // This acknowledges the kernel's stop enqueue, not the OS exit.
            void pending.then(() => nativePhase('native stop acknowledged'), () => nativePhase('native stop rejected'));
            return pending;
          };
          return process;
        } };
      },
      isExecutable: (value: string) => existsSync(value),
      searchPathFor: (name: string) => {
        if (name.toLowerCase().includes("bash") && shell.family === "bash") return shell.path;
        if (name.toLowerCase().includes("powershell")) return powershellPath;
        return existsSync(name) ? name : null;
      },
      buildAugmentedPath: () => process.env.PATH ?? "",
    }, native);
    const seen: TerminalCommandRecord[] = [];
    const subscription = runtime.subscribeCommands((event) => { seen.push(event); });
    try {
      phase('creating');
      const handle = await runtime.createTerminalSession({
        sessionId: "live-user",
        cwd,
        owner: "user",
        shell: shell.shell,
      });
      phase('created');
      await vi.waitFor(() => expect(runtime.inspectSession(handle.id)?.integration).toBe('ready'), { timeout: 15_000 });
      phase('integration ready');
      await handle.write("echo varin-live-probe\r");
      phase('input acknowledged');
      await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({
        command: expect.stringContaining("echo varin-live-probe"),
        owner: "user",
        integration: "osc-633",
        terminalId: "live-user",
        exitCode: 0,
      })), { timeout: 15_000 });
      phase('command observed');
      // Observe only frames already delivered and durable receipt metadata. A
      // process.list/read call could reconcile state and mask a missed wakeup.
      // This timer neither settles destroy nor releases its original process.
      let diagnosticPasses = 0;
      const reportedTraceFiles = new Set<string>();
      const diagnostic = setInterval(() => {
        // Bound the probe to the original 35 s test budget; never keep a
        // timed-out fixture printing forever. No retry or success is inferred.
        if (++diagnosticPasses >= 5) clearInterval(diagnostic);
        reportPendingStages = true;
        console.info('[live shell] pending destroy', { nativePhases, nativeStages, lastControl, lastData });
        if (!nativeRoot) return;
        const directory = path.join(nativeRoot, 'storage', 'process-receipts');
        void fs.readdir(directory).then(async names => {
          console.info('[live shell] native receipt files', {
            treeReceipts: names.filter(name => name.endsWith('.json')).length,
            outputMarkers: names.filter(name => name.endsWith('.output.complete')).length,
          });
          for (const name of names.filter(name => name.endsWith('.json') || name.endsWith('.output') || name.endsWith('.output.complete') || name.endsWith('.trace'))) {
            const file = path.join(directory, name);
            if (name.endsWith('.trace')) {
              if (reportedTraceFiles.has(name)) continue;
              const value = JSON.parse(await fs.readFile(file, 'utf8')) as {
                processId: string; role: string; stages: Array<[string, number]>;
              };
              reportedTraceFiles.add(name);
              console.info('[live shell] stalled native phases', {
                processId: value.processId, role: value.role, stages: value.stages,
              });
            } else if (name.endsWith('.output')) {
              console.info('[live shell] native output file', { bytes: (await fs.stat(file)).size });
            } else {
              const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
              console.info('[live shell] native receipt metadata', {
                kind: name.endsWith('.json') ? 'tree' : 'output', status: value.status,
                processId: value.processId,
                treeConfirmed: value.treeConfirmed, stopApplied: value.stopApplied,
                exitCode: value.exitCode, complete: value.complete, endCursor: value.endCursor,
              });
            }
          }
        }).catch(() => phase('native receipt metadata unavailable'));
      }, 5_000);
      try { await handle.destroy(); }
      finally { clearInterval(diagnostic); reportPendingStages = false; }
      console.info('[live shell] native teardown', { nativePhases, nativeStages });
      phase('destroyed');
    } finally {
      subscription.dispose();
      phase('shutting down');
      await runtime.shutdown();
      phase('shutdown complete');
      await fs.rm(cwd, { recursive: true, force: true });
    }
  // Match the Store-shell case: startup, two observed phases and native teardown
  // cannot share the old 20s outer budget while each phase permits 15s.
  }, 35_000);
});
