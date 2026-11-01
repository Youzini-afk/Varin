import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openKnowledgeDatabase } from './database.js';

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const options = { dim: 8, syncMode: 'full' as const, autoBuildQuiver: false, loadTextIndex: false, payloadCacheMb: 0 };
function legacy(checkpoint: boolean, dim = 8) {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-upgrade-')); roots.push(root);
  const file = join(root, 'knowledge.tdb');
  const child = spawnSync(process.execPath, ['-e', `
    const { TriviumDB } = require(process.argv[1]);
    const options = JSON.parse(process.argv[3]);
    const db = new TriviumDB(process.argv[2], options);
    if (process.argv[4] === 'true') {
      db.insert(Array(options.dim).fill(0), { type: 'knowledge', content: '检查点原文' });
      db.createIndex('type'); db.flush();
    }
    const id = db.insert(Array(options.dim).fill(1), { type: 'knowledge', content: 'WAL 原文' });
    if (process.argv[4] === 'true') db.link(1, id, 'related');
    process.exit(0); // An acknowledged WAL without a successful close.
  `, require.resolve('triviumdb-upgrade-0.8'), file, JSON.stringify({ ...options, dim }), String(checkpoint)], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  expect(child.error ?? child.status, child.stderr).toBe(0);
  return file;
}

it('upgrades a 0.8 checkpoint and its pending WAL without changing node identities or graph links', () => {
  const file = legacy(true);
  const db = openKnowledgeDatabase(file, options);
  try {
    expect(db.nodeCount()).toBe(2);
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: '检查点原文' });
    expect(db.getPayload(2)).toEqual({ type: 'knowledge', content: 'WAL 原文' });
    expect(db.get(1)?.edges).toContainEqual(expect.objectContaining({ targetId: 2, label: 'related' }));
    db.updatePayload(2, { type: 'knowledge', content: '新版本修订' });
  } finally { db.close(); }
  const reader = openKnowledgeDatabase(file, { ...options, accessMode: 'readOnly' });
  try { expect(reader.getPayload(2)).toEqual({ type: 'knowledge', content: '新版本修订' }); }
  finally { reader.close(); }
});

it.each([1, 8])('automatically checkpoints an old WAL-only store with dimension %s, preserving read-only opens', dim => {
  const file = legacy(false, dim);
  const wal = readFileSync(`${file}.wal`);
  expect(() => openKnowledgeDatabase(file, { ...options, dim, accessMode: 'readOnly' })).toThrow();
  expect(readFileSync(`${file}.wal`)).toEqual(wal);
  const db = openKnowledgeDatabase(file, { ...options, dim });
  try {
    expect(db.nodeCount()).toBe(1);
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: 'WAL 原文' });
    expect(db.get(1)?.vector).toEqual(Array(dim).fill(1));
  } finally { db.close(); }
  const reopened = openKnowledgeDatabase(file, { ...options, dim });
  try { expect(reopened.getPayload(1)).toEqual({ type: 'knowledge', content: 'WAL 原文' }); }
  finally { reopened.close(); }
});

it('preserves a damaged main file and reports its original error', () => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-damage-')); roots.push(root);
  const file = join(root, 'knowledge.tdb'), original = Buffer.from('damaged database');
  writeFileSync(file, original);
  expect(() => openKnowledgeDatabase(file, options)).toThrow();
  expect(readFileSync(file)).toEqual(original);
});

it('does not discard a corrupt legacy WAL during checkpoint upgrade', () => {
  const file = legacy(false), wal = readFileSync(`${file}.wal`);
  wal.writeUInt8(wal.readUInt8(wal.length - 1) ^ 0x40, wal.length - 1);
  writeFileSync(`${file}.wal`, wal);
  expect(() => openKnowledgeDatabase(file, options)).toThrow();
  expect(readFileSync(`${file}.wal`)).toEqual(wal);
});
