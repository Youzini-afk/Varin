import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function credentialDirectory(env = process.env) {
  return env.VARIN_GMAIL_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'varin-gmail');
}

const effectiveUid = () => typeof process.geteuid === 'function' ? process.geteuid()
  : typeof process.getuid === 'function' ? process.getuid() : undefined;

async function privateDirectory(directory, create) {
  if (create) await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Gmail credential directory is invalid');
  if (process.platform !== 'win32' && effectiveUid() !== undefined && info.uid !== effectiveUid()) {
    throw new Error('Gmail credential directory is owned by another OS user');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    if (!create) throw new Error('Gmail credential directory is accessible by other users');
    await chmod(directory, 0o700);
  }
}

function validateCredentials(value) {
  if (!value || typeof value !== 'object' || typeof value.client_id !== 'string' || !value.client_id ||
      typeof value.refresh_token !== 'string' || !value.refresh_token) {
    throw new Error('Gmail credentials are invalid; connect again');
  }
  if (value.kind === 'publisher') return { kind: 'publisher', client_id: value.client_id, refresh_token: value.refresh_token };
  if (value.kind !== undefined || typeof value.client_secret !== 'string' || !value.client_secret) {
    throw new Error('Gmail credentials are invalid; connect again');
  }
  return { client_id: value.client_id, client_secret: value.client_secret, refresh_token: value.refresh_token };
}

export async function saveCredentials(directory, value, { signal } = {}) {
  const credentials = validateCredentials(value);
  await privateDirectory(directory, true);
  const target = join(directory, 'credentials.json');
  const temporary = join(directory, `.credentials-${randomBytes(16).toString('hex')}`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { await file.writeFile(JSON.stringify(credentials)); await file.sync(); } finally { await file.close(); }
    signal?.throwIfAborted();
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function loadCredentials(directory = credentialDirectory()) {
  try {
    await privateDirectory(directory, false);
    const file = await open(join(directory, 'credentials.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
        || (effectiveUid() !== undefined && info.uid !== effectiveUid())))) {
        throw new Error('Gmail credential file permissions are unsafe');
      }
      return validateCredentials(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Gmail credentials could not be loaded; check local permissions or connect again');
  }
}

export function parseDesktopClient(json) {
  let content;
  try {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 65536) throw new Error();
    content = JSON.parse(json);
  } catch { throw new Error('Could not read the Google Desktop OAuth client JSON file'); }
  const client = content?.installed;
  if (!client || typeof client.client_id !== 'string' || !client.client_id ||
      typeof client.client_secret !== 'string' || !client.client_secret) {
    throw new Error('Expected the JSON file for a Google Desktop OAuth client');
  }
  return { client_id: client.client_id, client_secret: client.client_secret };
}

export async function readDesktopClient(path) {
  let json;
  try { json = await readFile(path, 'utf8'); }
  catch { throw new Error('Could not read the Google Desktop OAuth client JSON file'); }
  return parseDesktopClient(json);
}

export async function removeCredentials(directory = credentialDirectory()) {
  try { await privateDirectory(directory, false); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  await rm(join(directory, 'credentials.json'), { force: true });
}
