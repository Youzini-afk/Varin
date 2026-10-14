/** Read the existing project-trust asset without constructing a Pi SDK or writing on read. */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assetPath(value: string): string {
  let path = value.startsWith('file://') ? fileURLToPath(value) : value;
  if (process.platform === 'win32' && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(path)) {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_match, drive: string, rest = '') => `${drive.toUpperCase()}:\\${rest.replaceAll('/', '\\')}`);
  }
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || process.platform === 'win32' && path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  return resolve(path);
}
/** This is an existing external asset location, never the new models/MCP configuration directory. */
export function resolvePiAgentDirectory(directory?: string): string {
  return assetPath(directory ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
}
export function readProjectTrust(directory: string, cwd: string): boolean | null {
  let raw: string;
  try { raw = readFileSync(join(assetPath(directory), 'trust.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const data: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.values(data).some(value => value !== true && value !== false && value !== null)) throw new Error('Project trust store is malformed');
  let current = assetPath(cwd);
  try { current = realpathSync(current); } catch { /* Existing trust paths can precede a directory's creation. */ }
  for (;;) {
    const decision = Object.hasOwn(data, current) ? (data as Record<string, unknown>)[current] : undefined;
    if (typeof decision === 'boolean') return decision;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
