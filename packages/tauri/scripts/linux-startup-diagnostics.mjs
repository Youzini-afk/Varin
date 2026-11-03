/** Fixed startup signatures only. Never retain or publish child stderr, paths,
 * arguments, environment, page content or a native error's arbitrary text. */
import fs from 'node:fs/promises';

const signatures = [
  ['no-usable-sandbox', /No usable sandbox!/iu],
  ['namespace-denied', /(?:Failed to move to new namespace[^\r\n]{0,256}(?:Operation not permitted|Permission denied)|(?:Failed to (?:create|unshare)|cannot create)[^\r\n]{0,96}(?:user )?namespace[^\r\n]{0,96}(?:Operation not permitted|Permission denied))/iu],
  ['suid-sandbox-helper', /(?:The SUID sandbox helper binary was found, but is not configured correctly|The setuid sandbox is not running as root|The SUID sandbox helper binary is missing)/iu],
  ['missing-display', /(?:Missing X server or \$DISPLAY|cannot open display|Unable to open X display|Failed to connect to (?:the )?Wayland display)/iu],
  ['missing-shared-library', /error while loading shared libraries:[^\r\n]{0,256}: cannot open shared object file/iu],
];

export function createStartupClassifier() {
  const found = new Set();
  // Patterns above span at most 512 characters. This bounded suffix handles
  // chunk boundaries without ever accumulating an output log.
  let tail = '';
  return {
    write(chunk) {
      const value = String(chunk);
      for (let offset = 0; offset < value.length; offset += 512) {
        const text = tail + value.slice(offset, offset + 512);
        for (const [name, pattern] of signatures) if (pattern.test(text)) found.add(name);
        tail = text.slice(-512);
      }
    },
    finish() {
      tail = '';
      return signatures.flatMap(([name]) => found.has(name) ? [name] : []);
    },
  };
}

// These are read-only observations, not conclusions about which policy caused
// a child failure. Missing or unreadable values must never be called disabled.
const settings = [
  ['unprivilegedUsernsClone', '/proc/sys/kernel/unprivileged_userns_clone', 'boolean'],
  ['maxUserNamespaces', '/proc/sys/user/max_user_namespaces', 'integer'],
  ['apparmorRestrictUnprivilegedUserns', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'boolean'],
  ['apparmorRestrictUnprivilegedUnconfined', '/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined', 'boolean'],
  ['apparmorEnabled', '/sys/module/apparmor/parameters/enabled', 'enabled'],
  ['apparmorConfinement', '/proc/self/attr/current', 'confinement'],
];
async function readBounded(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(257);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > 256 ? null : buffer.toString('utf8', 0, bytesRead).trim();
  } finally { await handle.close(); }
}
export async function readLinuxStartupState({read = readBounded} = {}) {
  const result = {};
  for (const [name, file, kind] of settings) {
    try {
      const text = await read(file);
      let value;
      if (kind === 'boolean' && /^(?:0|1)$/u.test(text ?? '')) value = Number(text);
      if (kind === 'integer' && /^\d{1,16}$/u.test(text ?? '') && Number.isSafeInteger(Number(text))) value = Number(text);
      if (kind === 'enabled' && /^(?:Y|N)$/u.test(text ?? '')) value = text === 'Y';
      if (kind === 'confinement' && typeof text === 'string') {
        if (text === 'unconfined') value = 'unconfined';
        else if (/ \((enforce|complain|kill)\)$/u.test(text)) value = text.match(/ \((enforce|complain|kill)\)$/u)[1];
      }
      result[name] = value === undefined ? {status:'unrecognized'} : {status:'observed',value};
    } catch (error) {
      result[name] = {status:error.code === 'ENOENT' ? 'missing' : ['EACCES','EPERM'].includes(error.code) ? 'denied' : 'unavailable'};
    }
  }
  return result;
}
