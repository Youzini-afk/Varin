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

test('native observation timeout never kills a reused numeric process scope and preserves uncertainty when evidence writing fails',{skip:process.platform!=='linux'},async()=>{
 const payload=await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-timeout-test-')),session=await createSmokeSession();
 const completed=path.join(session.data,'completed.txt'),unwritable=path.join(payload,'not-a-directory');
 await fs.writeFile(unwritable,'ordinary file');
 await fs.writeFile(path.join(payload,'varin'),`#!${process.execPath}\nsetTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(completed)},'completed');process.exit(1);},250);\n`,{mode:0o755});
 try{
  await assert.rejects(smokeNative({payload,runtime:payload,runtimeManifest:{sha256:'fixture'},engineManifest:{sha256:'fixture'}},{session,output:path.join(unwritable,'report.json'),timeoutMs:100}),error=>{
   assert.equal(error.cleanupUncertain,true);assert.equal(error.nativeObservation.timedOut,true);assert.equal(error.nativeObservation.reportWriteFailed,true);
   assert.equal(error.nativeObservation.status.termination,'not-attempted-without-launch-bound-process-scope');return true;
  });
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(await fs.readFile(completed,'utf8'),'completed');
  // This finite no-descendant fixture completed its sole effect and exits.
  await fs.rm(session.root,{recursive:true,force:true});await fs.rm(payload,{recursive:true,force:true});
 }catch(error){throw error;} // Unknown fixture lifetime retains all private files.
});

test('passed native owner receipts and root exit never authorize unproven CEF scope cleanup',{skip:process.platform!=='linux'},async()=>{
 const payload=await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-owner-test-')),session=await createSmokeSession();
 // This process fixture tests orchestration policy, not CEF/product behavior.
 const names=['application-bridge','browser-same-page','browser-authority-isolation','browser-context-isolation','browser-capture','browser-pending-close','browser-download-terminal','osr-alpha-composition','network-stream-cancel','renderer-sandbox','native-drain'];
 const script=`#!${process.execPath}\nconst fs=require('fs'),path=require('path');const data=process.env.VARIN_DATA_DIR;const request=JSON.parse(fs.readFileSync(path.join(data,'smoke-request.json'),'utf8'));fs.writeFileSync(path.join(data,'smoke-report.json'),JSON.stringify({schema:1,product:'varin-desktop-native-smoke',platform:process.platform,architecture:process.arch,nonce:request.nonce,complete:true,cases:${JSON.stringify(names)}.map(name=>({name,status:'passed',...(name==='native-drain'?{evidence:{browserOwnerDrained:true,applicationAndHostScopesEnded:true}}:{})}))}));\n`;
 await fs.writeFile(path.join(payload,'varin'),script,{mode:0o755});
 try{
  await assert.rejects(smokeNative({payload,runtime:payload,runtimeManifest:{sha256:'fixture'},engineManifest:{sha256:'fixture'}},{session}),error=>{
   assert.equal(error.cleanupUncertain,true);assert.equal(error.nativeObservation.status.code,0);
   assert.equal(error.nativeObservation.nativeOwnersDrained,true);assert.equal(error.nativeObservation.fullProcessScopeDrained,false);
   assert.equal(error.nativeObservation.retainedPrivateDirectory,session.root);return /scope completion is unconfirmed/u.test(error.message);
  });
  assert.equal((await fs.stat(session.data)).isDirectory(),true);
 }finally{
  // The test fixture spawned no children. The actual runner never cleans here.
  await fs.rm(session.root,{recursive:true,force:true});await fs.rm(payload,{recursive:true,force:true});
 }
});

test('restart refuses a prior app-only drain receipt before replacing or removing any controls',async t=>{
 const session=await createSmokeSession();t.after(()=>fs.rm(session.root,{recursive:true,force:true}));
 const prior={schema:1,product:'varin-desktop-native-smoke',platform:process.platform,architecture:process.arch,nonce:'prior-native-nonce',complete:true,cases:[{name:'native-drain',status:'passed',evidence:{browserOwnerDrained:true,applicationAndHostScopesEnded:true}}]};
 const files={'smoke-report.json':JSON.stringify(prior),'smoke-ready.json':'original-ready','smoke-protocol-activation.json':'original-activation','smoke-request.json':'original-request'};
 for(const [name,bytes]of Object.entries(files))await fs.writeFile(path.join(session.data,name),bytes);
 const before=(await fs.readdir(session.data)).sort();
 await assert.rejects(smokeNative({payload:session.root,runtime:session.root},{session,restart:true}),error=>error.cleanupUncertain===true&&/restart requires confirmed full original process-scope/u.test(error.message));
 assert.deepEqual((await fs.readdir(session.data)).sort(),before);
 for(const [name,bytes]of Object.entries(files))assert.equal(await fs.readFile(path.join(session.data,name),'utf8'),bytes);
});
