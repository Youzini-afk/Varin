import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {stageLegacyElectron,validateLegacyManifest} from './legacy-runtime.mjs';
import {inventory} from './runtime-manifest.mjs';
import {frameworkPath,macFrameworkFixture} from './test-fixtures/mac-framework.mjs';
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
   await assert.rejects(stageLegacyElectron(input),/symbolic link/);
 }
});

test('macOS staging preserves canonical framework aliases and relocates without its source', {skip:process.platform==='win32'}, async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-mac-legacy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),destination=path.join(root,'runtime/legacy-electron');
 const links=await macFrameworkFixture(source);await fs.mkdir(path.dirname(destination));
 const legacy=await stageLegacyElectron({source,destination,platform:'darwin',architecture:'arm64',version:'1.2.3',sourceSha:'a'.repeat(40)});
 assert.deepEqual(legacy.links,links);
 for(const link of links)assert.equal(await fs.readlink(path.join(destination,link.path)),link.target);
 await fs.rm(source,{recursive:true});
 const files=await inventory(path.dirname(destination),{platform:'darwin',legacyElectron:legacy});
 validateLegacyManifest({platform:'darwin',legacyElectron:legacy,files});
 assert.ok(files.some(file=>file.path.endsWith('/Versions/A/Electron Framework')));
 assert.ok(!files.some(file=>file.path.includes('/Versions/Current/')||file.path===`legacy-electron/${frameworkPath}/Electron Framework`));
 assert.equal(await fs.readFile(path.join(destination,frameworkPath,'Resources/Info.plist'),'utf8'),await fs.readFile(path.join(destination,frameworkPath,'Versions/A/Resources/Info.plist'),'utf8'));
});

test('macOS staging rejects unsupported, escaping, cyclic and dangling aliases before copying', {skip:process.platform==='win32'}, async t=>{
 for(const [name,relative,target] of [
   ['external',`${frameworkPath}/Resources`,'../../../../outside'],
   ['absolute',`${frameworkPath}/Resources`,'/tmp/outside'],
   ['cycle',`${frameworkPath}/Versions/Current`,'Current'],
   ['dangling',`${frameworkPath}/Versions/Current`,'Missing'],
   ['unscoped','Varin.app/Contents/MacOS/Varin','../Frameworks/Electron Framework.framework/Electron Framework'],
   ['wrong-leaf',`${frameworkPath}/Resources`,'Versions/Current/Helpers'],
   ['version-alias',`${frameworkPath}/Versions/A`,'Current'],
 ])await t.test(name,async t=>{
   const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-invalid-mac-legacy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
   const source=path.join(root,'source'),destination=path.join(root,'legacy-electron');await macFrameworkFixture(source);
   await fs.rm(path.join(source,relative),{recursive:true,force:true});await fs.symlink(target,path.join(source,relative));
   await assert.rejects(stageLegacyElectron({source,destination,platform:'darwin',architecture:'arm64',version:'1.2.3',sourceSha:'a'.repeat(40)}));
   await assert.rejects(fs.lstat(destination),{code:'ENOENT'});
 });
});
