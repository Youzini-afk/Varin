import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/** Hold a real named Job and its original process object at a stdin gate.
 * This fixture does not change limits on an existing Job or production process.
 */
export async function holdWindowsJob(name: string) {
  const source = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class VarinRecoveryJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Run(string name) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int createError = Marshal.GetLastWin32Error();
    Process child = null;
    try {
      if (createError == 183) throw new Exception("Original Job is still named; replacement fixture refused");
      child = Process.Start(new ProcessStartInfo {
        FileName = Environment.GetEnvironmentVariable("ComSpec"),
        Arguments = "/d /c set /p VARIN_RECOVERY_GATE=",
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
      });
      if (!AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (WaitForSingleObject(child.Handle, 0) != 258) throw new Exception("Original fixture process is not live");
      Console.WriteLine("VARIN_JOB_READY");
      Console.Out.Flush();
      Console.ReadLine();
      if (WaitForSingleObject(child.Handle, 0) != 258) throw new Exception("Fixture gate was lost");
      child.StandardInput.WriteLine("stop");
      child.StandardInput.Flush();
      if (WaitForSingleObject(child.Handle, 10000) != 0) throw new Exception("Original fixture process did not stop");
    } finally {
      if (child != null) {
        if (!child.HasExited) { child.Kill(); child.WaitForExit(); }
        child.Dispose();
      }
      CloseHandle(job);
    }
  }
}`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${source}\n'@; [VarinRecoveryJob]::Run($env:VARIN_TEST_JOB_NAME)`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VARIN_TEST_JOB_NAME: name },
  });
  // An early fixture failure can close the input before cleanup sends its gate.
  // The awaited process result below remains authoritative for that failure.
  child.stdin.on('error', () => {});
  let output = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data: string) => { output += data; });
  child.stderr.on('data', (data: string) => { errors += data; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const stop = async () => {
    child.stdin.end('\n');
    assert.equal(await exited, 0, errors);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Job fixture did not become ready: ${errors}`)), 15_000);
      const observe = () => {
        if (output.includes('VARIN_JOB_READY')) { clearTimeout(deadline); resolve(); }
      };
      child.stdout.on('data', observe);
      void exited.then(() => { clearTimeout(deadline); reject(new Error(`Job fixture exited before readiness: ${errors}`)); }, reject);
      observe();
    });
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  return { stop };
}
