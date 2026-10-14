/** Native project trust. Reads never create, import or repair assets. */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonicalProjectTrustPath(value: string): string {
  let path = value.startsWith('file://') ? fileURLToPath(value) : value;
  if (process.platform === 'win32' && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(path)) {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_match, drive: string, rest = '') => `${drive.toUpperCase()}:\\${rest.replaceAll('/', '\\')}`);
  }
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || process.platform === 'win32' && path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  return resolve(path);
}
export function projectTrustFile(directory: string): string { return join(canonicalProjectTrustPath(directory), 'project-trust.json'); }
export function validateProjectTrust(data: unknown): Record<string, boolean> {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.entries(data).some(([key, value]) => !key || ![true, false].includes(value as boolean))) throw new Error('Project trust store is malformed');
  return data as Record<string, boolean>;
}
export function projectTrustDecision(data: Record<string, boolean>, cwd: string): boolean | null {
  let current = canonicalProjectTrustPath(cwd);
  try { current = realpathSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (;;) {
    const decision = Object.hasOwn(data, current) ? data[current] : undefined;
    if (typeof decision === 'boolean') return decision;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
export function readProjectTrust(directory: string, cwd: string): boolean | null {
  let raw: string;
  try { raw = readFileSync(projectTrustFile(directory), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return projectTrustDecision(validateProjectTrust(JSON.parse(raw)), cwd);
}
