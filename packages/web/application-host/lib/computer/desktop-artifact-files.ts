import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { HarnessServiceError } from '../harness/service-error.js';
import type { LinuxDesktopState } from './linux-desktop.js';

export interface DesktopArtifactVersion {
  sha256: string;
  byteLength: number;
  /** Nanoseconds since the Unix epoch, as reported by the desktop filesystem. */
  modifiedAt: string;
}

const commandFor = (desktop: LinuxDesktopState, operation: 'info' | 'read' | 'write', relativePath: string, sha256?: string) => {
  if (desktop.state !== 'running' || !desktop.artifact || !desktop.home || !desktop.user || !Number.isSafeInteger(desktop.uid)) {
    throw new HarnessServiceError('unavailable', 'Managed desktop file access is unavailable');
  }
  const args = [desktop.artifact, operation, '--home', desktop.home, '--path', relativePath,
    ...(sha256 ? ['--sha256', sha256] : [])];
  return process.getuid?.() === 0 && desktop.uid !== 0
    ? { command: 'runuser', args: ['-u', desktop.user, '--', '/usr/bin/python3', ...args] }
    : { command: '/usr/bin/python3', args };
};

export const inspectDesktopFile = async (desktop: LinuxDesktopState, relativePath: string): Promise<DesktopArtifactVersion> => {
  const { command, args } = commandFor(desktop, 'info', relativePath);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (result.code !== 0) throw new HarnessServiceError('unavailable', result.stderr.trim() || 'Desktop artifact is unavailable');
  let version: DesktopArtifactVersion;
  try { version = JSON.parse(result.stdout) as DesktopArtifactVersion; }
  catch { throw new HarnessServiceError('unavailable', 'Desktop artifact returned malformed file metadata'); }
  if (!/^[0-9a-f]{64}$/u.test(version.sha256) || !Number.isSafeInteger(version.byteLength)
    || version.byteLength < 0 || !/^[0-9]+$/u.test(version.modifiedAt)) {
    throw new HarnessServiceError('unavailable', 'Desktop artifact returned invalid file metadata');
  }
  return version;
};

/**
 * Atomically replace one file inside the managed desktop user's home with
 * the supplied bytes, returning the stored revision. One-shot copy — this
 * creates no continuous sync with the caller's filesystem.
 */
export const writeDesktopFile = async (
  desktop: LinuxDesktopState,
  relativePath: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<DesktopArtifactVersion> => {
  signal?.throwIfAborted();
  const { command, args } = commandFor(desktop, 'write', relativePath);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) });
    let stdout = ''; let stderr = '';
    let abortError: Error | undefined;
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => { if (error.name === 'AbortError') abortError = error; else reject(error); });
    child.once('close', (code) => { if (abortError) reject(abortError); else resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => { /* Exit/error receipt owns a closed stdin. */ });
    child.stdin.end(content);
  });
  if (result.code !== 0) throw new HarnessServiceError('unavailable', result.stderr.trim() || 'Desktop file write failed');
  let version: DesktopArtifactVersion;
  try { version = JSON.parse(result.stdout) as DesktopArtifactVersion; }
  catch { throw new HarnessServiceError('unavailable', 'Desktop file write returned malformed metadata'); }
  if (!/^[0-9a-f]{64}$/u.test(version.sha256) || !Number.isSafeInteger(version.byteLength)
    || version.byteLength < 0 || !/^[0-9]+$/u.test(version.modifiedAt)) {
    throw new HarnessServiceError('unavailable', 'Desktop file write returned invalid metadata');
  }
  return version;
};

export const openDesktopFile = (desktop: LinuxDesktopState, relativePath: string, sha256: string): Promise<{ stream: Readable; cancel(): void }> => {
  const { command, args } = commandFor(desktop, 'read', relativePath, sha256);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let ready = false;
    child.stderr.on('data', (data) => {
      stderr += data;
      if (!ready && stderr.includes('VARIN_ARTIFACT_READY\n')) {
        ready = true;
        resolve({ stream: child.stdout, cancel: () => child.kill() });
      }
    });
    child.once('error', (error) => { if (ready) child.stdout.destroy(error); else reject(error); });
    child.once('close', (code) => {
      if (code !== 0) {
        const error = new HarnessServiceError('unavailable', stderr.replace('VARIN_ARTIFACT_READY', '').trim() || 'Desktop artifact read failed');
        if (ready) child.stdout.destroy(error);
        else reject(error);
      } else if (!ready) reject(new HarnessServiceError('unavailable', 'Desktop artifact returned no readable stream'));
    });
  });
};
