/** Native opens stay in the private storage owner. The old engine is used only
 * to finish a pre-0.9 WAL-only checkpoint, then exits before the current open. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { TriviumDBOptions } from 'triviumdb';

const require = createRequire(import.meta.url);
const { TriviumDB } = require('triviumdb') as typeof import('triviumdb');
const checkpointLegacyWal = `
  const fs = require('node:fs');
  const { crc32 } = require('node:zlib');
  // 0.8 stops replay at a bad CRC. Reject complete corrupt frames before it
  // opens the writer, so upgrading cannot silently discard committed data.
  const fd = fs.openSync(process.argv[2] + '.wal', 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(6), word = Buffer.alloc(4), block = Buffer.alloc(64 * 1024);
    const read = (buffer, length, position) => {
      let done = 0;
      while (done < length) {
        const count = fs.readSync(fd, buffer, done, length - done, position + done);
        if (!count) throw new Error('Legacy WAL changed during upgrade');
        done += count;
      }
    };
    read(header, 6, 0);
    if (header.toString('ascii', 0, 4) !== 'TVWL' || header.readUInt16LE(4) !== 3)
      throw new Error('Unsupported legacy WAL format');
    for (let offset = 6; offset + 4 <= size;) {
      read(word, 4, offset);
      const length = word.readUInt32LE(0), end = offset + 4 + length;
      if (end + 4 > size) break; // The original engine recovers a physically incomplete tail.
      let checksum = 0;
      for (let position = offset + 4; position < end;) {
        const count = Math.min(block.length, end - position);
        read(block, count, position);
        checksum = crc32(block.subarray(0, count), checksum); position += count;
      }
      read(word, 4, end);
      if (checksum !== word.readUInt32LE(0)) throw new Error('Corrupt legacy WAL frame at byte ' + offset);
      offset = end + 4;
    }
  } finally { fs.closeSync(fd); }
  const { TriviumDB } = require(process.argv[1]);
  const database = new TriviumDB(process.argv[2], JSON.parse(process.argv[3]));
  database.close();
`;

export function openKnowledgeDatabase(file: string, options: TriviumDBOptions) {
  try { return new TriviumDB(file, options); }
  catch (error) {
    const failure = error as { code?: string; details?: { reason?: string } };
    if (options.accessMode === 'readOnly' || options.accessMode === 'immutable'
      || failure.code !== 'TDB_CORRUPTED_FILE'
      || !failure.details?.reason?.includes('Typed checkpoint missing; recover and export with the original version')) throw error;
    // The failed open has released its lease. Let the original engine recover
    // its own WAL and publish a full checkpoint; never recreate the database
    // or translate WAL bytes in the Host.
    execFileSync(process.execPath, ['-e', checkpointLegacyWal,
      require.resolve('triviumdb-upgrade-0.8'), file,
      JSON.stringify({ dim: options.dim, dtype: options.dtype, syncMode: 'full',
        autoBuildQuiver: false, loadTextIndex: false, payloadCacheMb: 0 })], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    return new TriviumDB(file, options);
  }
}
