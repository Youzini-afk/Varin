import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const workspace = path.resolve(import.meta.dirname, '../../..');
const temporaryRoot = path.resolve(os.tmpdir());
const root = await mkdtemp(path.join(temporaryRoot, 'varin-browser-fixture-run-'));
const output = path.join(root, 'result.json');
try {
  const build = spawnSync('bun', ['build', 'packages/electron/scripts/browser-owner-fixture.ts', '--target=node', '--format=esm', '--external', 'electron', `--outfile=${path.join(root, 'fixture.mjs')}`], { cwd: workspace, windowsHide: true, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.error?.message || 'Browser fixture build failed');
  await writeFile(path.join(root, 'bootstrap.cjs'), `const fs=require('node:fs');const fail=error=>{fs.writeFileSync(process.argv[2],JSON.stringify({error:String(error.stack||error)}));require('electron').app.exit(1)};process.on('uncaughtException',fail);import('./fixture.mjs').catch(fail);`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [path.join(root, 'bootstrap.cjs'), output, root], { cwd: workspace, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const result = await readFile(output, 'utf8').catch(() => 'No fixture result');
  console.log(result);
  if (run.status !== 0) throw new Error(run.error?.message || run.stderr || `Browser fixture exited ${run.status}`);
} finally {
  // Only this invocation's generated directory, after its Electron process exits.
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('varin-browser-fixture-run-')) throw new Error('Fixture cleanup path escaped its temporary root');
  await rm(resolved, { recursive: true, force: true });
}
