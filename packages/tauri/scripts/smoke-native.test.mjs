import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateNativeSmoke,smokeNative,createSmokeSession} from './smoke-native.mjs';
test('native smoke requires fresh target-bound complete actual cases, not a successful exit alone',()=>{
 const report={schema:1,product:'varin-desktop-native-smoke',platform:process.platform,architecture:process.arch,nonce:'test',complete:true,cases:[{name:'browser-sandbox',status:'passed',evidence:{rendererObserved:true}}]};
 assert.equal(validateNativeSmoke(report,{nonce:'test',requiredCases:['browser-sandbox']}),report);
 for(const changed of [{...report,nonce:'stale'},{...report,complete:false},{...report,cases:[]},{...report,cases:[{name:'browser-sandbox',status:'not-run'}]},{...report,cases:[...report.cases,...report.cases]}])assert.throws(()=>validateNativeSmoke(changed,{nonce:'test'}));
 assert.throws(()=>validateNativeSmoke(report,{nonce:'test',requiredCases:['shutdown']}),/Missing/);
});

test('installed launch discovers its own runtime and directory instead of source overrides', {skip:process.platform!=='linux'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-installed-launch-test-'));
 const session=await createSmokeSession();t.after(async()=>{await fs.rm(root,{recursive:true,force:true});await fs.rm(session.root,{recursive:true,force:true});});
 const payload=path.join(root,'source'),installed=path.join(root,'installed'),assets=path.join(root,'assets');
 for(const dir of [payload,installed,assets])await fs.mkdir(dir);
 const file=path.join(installed,'Varin.AppImage');
 const script=`#!${process.execPath}\nrequire('fs').writeFileSync(require('path').join(process.env.VARIN_DATA_DIR,'observed.json'),JSON.stringify({cwd:process.cwd(),runtime:process.env.VARIN_DESKTOP_RUNTIME_DIR??null,appdir:process.env.APPDIR??null}));process.exit(1);\n`;
 await fs.writeFile(file,script,{mode:0o755});await fs.writeFile(path.join(assets,'Varin.AppImage'),script,{mode:0o755});
 await assert.rejects(smokeNative({payload,assets,runtime:'/source/runtime-must-not-be-used',packaged:{update:{name:'Varin.AppImage'}},runtimeManifest:{sha256:'fixture'},engineManifest:{sha256:'fixture'}},{installedExecutable:file,session,output:path.join(root,'report.json')}),/Native desktop smoke failed/);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(session.data,'observed.json'),'utf8')),{cwd:installed,runtime:null,appdir:null});
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'report.json'),'utf8')).cleanupUncertain,true);
});

test('native smoke refuses redirected session directories before writing request data',{skip:process.platform==='win32'},async t=>{
 const session=await createSmokeSession(),outside=await fs.mkdtemp(path.join(os.tmpdir(),'varin-smoke-outside-'));
 t.after(async()=>{await fs.rm(session.root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});});
 await fs.rmdir(session.data);await fs.symlink(outside,session.data);
 await assert.rejects(smokeNative({},{session}),/redirected/);
 await assert.rejects(fs.stat(path.join(outside,'smoke-request.json')),{code:'ENOENT'});
});

test('failed native launch retains the private scope instead of deleting unverified owner data',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-smoke-lifecycle-test-'));
 const output=path.join(root,'evidence.json');let retained;
 try{
  await assert.rejects(smokeNative({payload:root,runtime:path.join(root,'runtime'),target:`${process.platform}-${process.arch}`,
   sourceSha:'test-source',version:'0.0.0',runtimeManifest:{sha256:'runtime'},engineManifest:{sha256:'engine'}},{output,timeoutMs:2000}),{code:'ENOENT'});
  const evidence=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(evidence.cleanupUncertain,true);retained=evidence.retainedPrivateDirectory;
  assert.equal(JSON.parse(await fs.readFile(path.join(retained,'data/smoke-request.json'),'utf8')).schema,1);
 }finally{
  // This test launched no executable. Only that known outcome permits cleanup.
  if(retained)await fs.rm(retained,{recursive:true,force:true});
  await fs.rm(root,{recursive:true,force:true});
 }
});
