import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

function installedSigner(){
  const electronRequire=createRequire(new URL('../../electron/package.json',import.meta.url));
  const builderRequire=createRequire(electronRequire.resolve('electron-builder'));
  const libraryRequire=createRequire(builderRequire.resolve('app-builder-lib'));
  return libraryRequire.resolve('@electron/osx-sign');
}

test('the installed macOS signer discovers nested payloads within a bounded descriptor budget',async t=>{
  if(process.platform==='win32'){t.skip('POSIX per-process descriptor limit');return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-macos-sign-walk-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const contents=path.join(root,'Varin.app/Contents'),expected=[];
  // Enough independent native-module directories to expose recursive unbounded
  // discovery. No macOS executable, signing identity or platform call is used.
  for(let index=0;index<96;index++){
    const directory=path.join(contents,'Resources/node_modules',`module-${index}`);
    await fs.mkdir(directory,{recursive:true});
    for(let text=0;text<4;text++)await fs.writeFile(path.join(directory,`${text}.js`),'export const fixture = true;\n');
    const binary=path.join(directory,'binding.node');
    await fs.writeFile(binary,Buffer.from([0,1,2,3]));expected.push(binary);
  }
  const helper=path.join(contents,'Frameworks/Helper.app'),executable=path.join(helper,'Contents/MacOS/helper');
  await fs.mkdir(path.dirname(executable),{recursive:true});
  await fs.writeFile(executable,Buffer.from([0,1,2,3]));expected.push(executable,helper);
  const alias=path.join(contents,'Resources/binding-alias.node');
  await fs.symlink(path.relative(path.dirname(alias),expected[0]),alias);expected.push(alias);
  const stale=path.join(contents,'stale.cstemp');await fs.writeFile(stale,'old signing temporary file');
  const signer=installedSigner();
  const probe=path.join(root,'probe.cjs');
  await fs.writeFile(probe,`const {walkAsync}=require(${JSON.stringify(signer)});walkAsync(process.argv[2]).then(paths=>process.stdout.write(JSON.stringify(paths)),error=>{console.error(error);process.exitCode=1;});\n`);
  // Lower only this disposable test subprocess's soft limit. The fix must bound
  // I/O, not raise developer/runner limits or silently omit signable children.
  const result=spawnSync('/bin/sh',['-c','ulimit -n 64; exec "$@"','signer-probe',process.execPath,probe,contents],{encoding:'utf8',timeout:30_000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
  const discovered=JSON.parse(result.stdout);
  assert.deepEqual([...discovered].sort(),expected.sort());
  assert.ok(discovered.indexOf(executable)<discovered.indexOf(helper),'nested code precedes its enclosing bundle');
  await assert.rejects(fs.stat(stale),{code:'ENOENT'});
});

test('the installed macOS signer fails on unreadable discovery instead of omitting a child',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-macos-sign-error-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const require=createRequire(import.meta.url),{walkAsync}=require(installedSigner());
  await assert.rejects(walkAsync(path.join(root,'missing')),{code:'ENOENT'});
  if(process.platform!=='win32'){
    await fs.symlink('missing-native-binary',path.join(root,'broken.node'));
    await assert.rejects(walkAsync(root),{code:'ENOENT'});
  }
});
