import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {stageLegacyElectron,validateLegacyManifest} from './legacy-runtime.mjs';
import {inventory} from './runtime-manifest.mjs';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-legacy-stage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source');await fs.mkdir(source);
 const bytes=Buffer.alloc(128);bytes.write('MZ');bytes.writeUInt32LE(64,0x3c);bytes.write('PE\0\0',64);bytes.writeUInt16LE(0x8664,68);
 await fs.writeFile(path.join(source,'Varin.exe'),bytes);
 const input={source,destination:path.join(root,'legacy-electron'),platform:'win32',architecture:'x64',version:'1.2.3',sourceSha:'a'.repeat(40)};
 await fs.writeFile(path.join(source,'varin-exporter.json'),JSON.stringify({schema:1,protocol:1,...input,executable:'Varin.exe',entry:'--varin-export-private-state'}));
 return{root,input};
}
test('stages only matching controlled exporter and puts every required byte in the runtime inventory',async t=>{
 const{root,input}=await fixture(t);const legacy=await stageLegacyElectron(input);
 const files=(await inventory(input.destination)).map(record=>({...record,path:`legacy-electron/${record.path}`}));
 validateLegacyManifest({platform:'win32',legacyElectron:legacy,files});assert.equal(legacy.executable,'legacy-electron/Varin.exe');
 assert.throws(()=>validateLegacyManifest({platform:'win32',legacyElectron:{...legacy,executable:'../../arbitrary.exe'},files}),/Invalid/);
 await assert.rejects(stageLegacyElectron({...input,destination:path.join(root,'wrong'),architecture:'arm64'}),/architecture/);
});
test('wrong source receipt and external symlinks fail before legacy publication',async t=>{
 const{root,input}=await fixture(t);
 await assert.rejects(stageLegacyElectron({...input,sourceSha:'b'.repeat(40)}),/controlled exporter/);
 if(process.platform!=='win32'){
   await fs.writeFile(path.join(root,'outside'),'unrelated');await fs.symlink('../outside',path.join(input.source,'external'));
   await assert.rejects(stageLegacyElectron(input),/external symbolic link/);
 }
});
