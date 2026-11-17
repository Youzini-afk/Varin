import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const files = Object.freeze([
  '.env.example', 'README.md', 'compose.yaml', 'frps.toml', 'Caddyfile', 'offline/index.html',
  'snippets/frpc.toml', 'snippets/frps.toml', 'snippets/Caddyfile', 'snippets/nginx.conf', 'validate.sh',
]);

export const kitFiles = files;
export const kitArchivePath = 'downloads/varin-external-access.tar.gz';
const publicDirectory = 'downloads/varin-external-access/';
const snippets = new Set(['snippets/Caddyfile', 'snippets/nginx.conf']);

function octal(header, value, offset, length) {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
}

/** Fixed, deterministic ustar records for our small ASCII-named, text-only product templates. */
function tarEntry(file, bytes) {
  const path = `varin-external-access/${file}`;
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(path, 'ascii') > 100) throw new Error('Invalid external access archive member');
  header.write(path, 0, 100, 'ascii');
  octal(header, file === 'validate.sh' ? 0o755 : 0o644, 100, 8);
  octal(header, 0, 108, 8);
  octal(header, 0, 116, 8);
  octal(header, bytes.length, 124, 12);
  octal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar', 257, 5, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
}

export const kitDownloadPaths = Object.freeze([kitArchivePath, ...[...snippets].map(name => publicDirectory + name)]);

async function readTemplate(root, file) {
  const path = join(root, file);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error(`Invalid external access template: ${file}`);
  return readFile(path);
}

export async function buildExternalAccessDownloads(root, requestedPath) {
  if (requestedPath && !kitDownloadPaths.includes(requestedPath)) return new Map();
  const downloads = new Map();
  if (!requestedPath || requestedPath === kitArchivePath) {
    const contents = await Promise.all(files.map(async file => tarEntry(file, await readTemplate(root, file))));
    downloads.set(kitArchivePath, gzipSync(Buffer.concat([...contents.flat(), Buffer.alloc(1024)]), { level: 9 }));
  }
  for (const name of snippets) {
    const path = publicDirectory + name;
    if (!requestedPath || requestedPath === path) downloads.set(path, await readTemplate(root, name));
  }
  return downloads;
}
