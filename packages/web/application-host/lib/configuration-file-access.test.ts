import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withConfigurationFileAccess } from './configuration-file-access.js';
import { RevisionedTextFileEditor } from './mcp/revisioned-text-file-editor.js';
import { McpConfigurations } from './mcp/configuration.js';

const heldRead = vi.hoisted(() => ({ path: undefined as string | undefined, beforeClose: undefined as (() => Promise<void>) | undefined, closed: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (String(args[0]) === heldRead.path) {
      heldRead.path = undefined;
      const close = file.close.bind(file), beforeClose = heldRead.beforeClose!, closed = heldRead.closed!;
      // Delay only close: the real owner still opens, reads and stats the real file.
      file.close = async () => { try { await beforeClose(); } finally { await close(); closed(); } };
    }
    return file;
  } };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  heldRead.path = undefined; heldRead.beforeClose = undefined; heldRead.closed = undefined;
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-config-access-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'mcp.json');
  await writeFile(path, 'original');
  return { directory, path };
}

test('MCP preparation closes its real source handle before replacement without blocking another source', async () => {
  const { directory, path } = await fixture();
  const original = JSON.stringify({ mcpServers: { server: { command: 'original' } } });
  await writeFile(path, original);
  const candidate = join(directory, 'candidate.tmp');
  const replacement = JSON.stringify({ mcpServers: { server: { command: 'candidate' } } });
  await writeFile(candidate, replacement);
  const closeEntered = deferred(), finishRead = deferred();
  const events: string[] = [];
  heldRead.path = path;
  heldRead.beforeClose = async () => { closeEntered.resolve(); await finishRead.promise; };
  heldRead.closed = () => { events.push('closed'); };
  const reading = new McpConfigurations().prepare({ agentDir: directory, cwd: directory, projectTrusted: false });
  void reading.catch(() => undefined);
  await closeEntered.promise;
  const writing = withConfigurationFileAccess(path, async () => {
    expect(events).toContain('closed');
    await rename(candidate, path);
    events.push('replaced');
  });
  void writing.catch(() => undefined);
  // Another source can complete while the original reader still owns its file.
  try {
    await withConfigurationFileAccess(join(directory, 'other.json'), async () => { events.push('independent'); });
    expect(events).toEqual(['independent']);
  } finally { finishRead.resolve(); }
  const [loaded] = await Promise.all([reading, writing]);
  expect(loaded.errors).toEqual([]);
  expect(loaded.servers[0]?.config).toMatchObject({ command: 'original' });
  expect(events).toEqual(['independent', 'closed', 'replaced']);
  expect(await readFile(path, 'utf8')).toBe(replacement);
});

test('failed access releases admission and preserves the original failure and next revision CAS', async () => {
  const { path } = await fixture();
  const failure = Object.assign(new Error('source unavailable'), { code: 'EPERM' });
  await expect(withConfigurationFileAccess(path, async () => { throw failure; })).rejects.toBe(failure);
  const options = { conflictCode: 'config_conflict', conflictLabel: 'Configuration file' };
  const first = new RevisionedTextFileEditor(path, options);
  const second = new RevisionedTextFileEditor(path, options);
  const before = await first.read();
  const results = await Promise.allSettled([first.update('first', before.revision), second.update('second', before.revision)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'config_conflict' } }]);
  expect(['first', 'second']).toContain(await readFile(path, 'utf8'));
});

test.runIf(process.platform === 'win32')('an external target handle still reports raw failure without losing the original document', async () => {
  const { path } = await fixture();
  const editor = new RevisionedTextFileEditor(path, { conflictCode: 'config_conflict', conflictLabel: 'Configuration file' });
  const before = await editor.read();
  const externalReader = await open(path, 'r');
  try {
    await expect(editor.update('candidate', before.revision)).rejects.toMatchObject({ code: 'EPERM', syscall: 'rename' });
    expect(await externalReader.readFile('utf8')).toBe('original');
  } finally { await externalReader.close(); }
  expect(await editor.read()).toEqual(before);
});
