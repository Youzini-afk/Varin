import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverCef, engineInventory } from './build-candidate.mjs';

test('candidate discovery accepts only the official target/version receipt', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-cef-discovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const lock=JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json',import.meta.url),'utf8'));
  for(const [target,pin] of Object.entries(lock.targets)) {
    const [platform,architecture]=target.split('-');
    await fs.writeFile(path.join(root,'archive.json'),JSON.stringify({name:`cef_binary_${lock.version}_${pin.upstream}_minimal.tar.bz2`,type:'minimal',sha1:pin.sha1}));
    assert.equal(await discoverCef(root,platform,architecture),root);
    await assert.rejects(discoverCef(root,platform,architecture==='x64'?'arm64':'x64'),/receipt/);
  }
  await fs.writeFile(path.join(root,'archive.json'),JSON.stringify({name:'different',type:'minimal',sha1:'0'.repeat(40)}));
  await assert.rejects(discoverCef(root,'linux','x64'),/receipt/);
});
test('engine receipts hash actual bytes and permit only contained framework links', {skip:process.platform==='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-engine-inventory-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'app');await fs.mkdir(path.join(dir,'runtime'),{recursive:true});
  await fs.writeFile(path.join(dir,'engine'),'first');await fs.writeFile(path.join(dir,'runtime','host'),'excluded');
  await fs.symlink('engine',path.join(dir,'framework-link'));
  const first=await engineInventory(dir,{exclude:'runtime'});assert.deepEqual(first.map(f=>f.path),['engine','framework-link']);
  await fs.writeFile(path.join(dir,'engine'),'changed');
  assert.notEqual((await engineInventory(dir,{exclude:'runtime'}))[0].sha256,first[0].sha256);
  await fs.writeFile(path.join(root,'outside'),'outside');await fs.symlink('../outside',path.join(dir,'external-link'));
  await assert.rejects(engineInventory(dir),/external symbolic/);
});
