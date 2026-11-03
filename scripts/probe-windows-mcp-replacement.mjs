// One-shot diagnostic, not an acceptance test or a product fallback.
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'varin-mcp-replacement-probe-'));
const original = 'synthetic-original';
const candidate = 'synthetic-candidate';
const outcomes = [];
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }));

async function contents(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

try {
  for (const mode of ['closed-target', 'held-target', 'held-source', 'directory-watch', 'target-closed-before-replace']) {
    const directory = join(root, mode);
    await mkdir(directory);
    const source = join(directory, 'mcp.json.tmp');
    const target = join(directory, 'mcp.json');
    await writeFile(target, original);
    await writeFile(source, candidate);
    let handle;
    let watcher;
    try {
      if (mode === 'held-target' || mode === 'target-closed-before-replace') handle = await open(target, 'r');
      if (mode === 'held-source') handle = await open(source, 'r');
      if (mode === 'directory-watch') watcher = watch(directory, () => {});
      if (mode === 'target-closed-before-replace') { await handle.close(); handle = undefined; }

      // Exactly one replacement attempt per independent fixture. No retry.
      let failure;
      try { await rename(source, target); }
      catch (error) { failure = { code: error.code, syscall: error.syscall }; }
      const actualTarget = await contents(target);
      const actualSource = await contents(source);
      assert.equal(actualTarget, failure ? original : candidate);
      assert.equal(actualSource, failure ? candidate : null);
      const result = { mode, outcome: failure ?? 'replaced', originalPreserved: actualTarget === original, candidatePreserved: actualSource === candidate };
      outcomes.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await handle?.close();
      watcher?.close();
    }
  }
  for (const mode of ['closed-target', 'target-closed-before-replace']) {
    assert.equal(outcomes.find(result => result.mode === mode)?.outcome, 'replaced', `${mode} must replace successfully`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
