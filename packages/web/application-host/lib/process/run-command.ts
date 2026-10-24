import { stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { launchOwnedProcess, managedExitConfirmed, terminateOwnedProcess, waitForManagedExit,
  type ManagedProcessOwner, type ManagedSpawn } from "./types.js";
const aborted = (signal?: AbortSignal): unknown => signal?.reason ?? new DOMException("Process cancelled", "AbortError");
const throwIfAborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw aborted(signal); };

export const executableExists = async (command: string): Promise<boolean> => {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const names = process.platform === "win32" && !extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()))
    ? [command, ...extensions.map((extension) => command + extension)] : [command];
  const directories = isAbsolute(command) || command.includes(sep) || command.includes("/") ? [""] : (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  for (const directory of directories) {
    for (const name of names) {
      try {
        const file = await stat(directory ? join(directory, name) : name);
        if (file.isFile() && (process.platform === "win32" || (file.mode & 0o111) !== 0)) return true;
      } catch { /* continue along PATH */ }
    }
  }
  return false;
};

export interface ProcessDirectoryState { safeToRemove: boolean; onLateExitConfirmed?(): Promise<void> }

export const runOwnedCommand = async (
  spawn: ManagedSpawn, command: string, args: string[], cwd: string,
  signal?: AbortSignal, directoryState?: ProcessDirectoryState,
): Promise<{ stdout: string; stderr: string }> => {
  throwIfAborted(signal);
  const owner: ManagedProcessOwner = { child: null };
  let aborting: Promise<void> | undefined;
  const onAbort = (): void => { aborting ??= terminateOwnedProcess(owner, true); void aborting.catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const child = await launchOwnedProcess(owner, (launchSignal) => spawn(command, args, {
      cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: launchSignal,
    }));
    if (directoryState) directoryState.safeToRemove = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    if (!child.stdout || !child.stderr) throw new Error("Managed process did not provide piped output");
    if (signal?.aborted) onAbort();
    await waitForManagedExit(child);
    if (directoryState) directoryState.safeToRemove = managedExitConfirmed(child);
    if (signal?.aborted) { await aborting; throw aborted(signal); }
    if (child.exitCode !== 0 || child.signalCode) {
      throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${child.signalCode ?? child.exitCode ?? "unknown"}`);
    }
    return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } catch (error) {
    if (signal?.aborted) {
      await (aborting ?? terminateOwnedProcess(owner, true));
      if (directoryState) directoryState.safeToRemove = managedExitConfirmed(owner.child);
      throw aborted(signal);
    }
    if (directoryState) directoryState.safeToRemove = managedExitConfirmed(owner.child);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (directoryState && !directoryState.safeToRemove && directoryState.onLateExitConfirmed && owner.child) {
      const child = owner.child;
      void waitForManagedExit(child).then(async () => {
        if (managedExitConfirmed(child)) { directoryState.safeToRemove = true; await directoryState.onLateExitConfirmed?.(); }
      }).catch(() => { /* The original process owner still has no confirmed exit. */ });
    }
  }
};
