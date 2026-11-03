import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateNativeSmoke,smokeNative} from './smoke-native.mjs';
test('native smoke requires fresh target-bound complete actual cases, not a successful exit alone',()=>{
 const report={schema:1,product:'varin-desktop-native-smoke',platform:process.platform,architecture:process.arch,nonce:'test',complete:true,cases:[{name:'browser-sandbox',status:'passed',evidence:{rendererObserved:true}}]};
 assert.equal(validateNativeSmoke(report,{nonce:'test',requiredCases:['browser-sandbox']}),report);
 for(const changed of [{...report,nonce:'stale'},{...report,complete:false},{...report,cases:[]},{...report,cases:[{name:'browser-sandbox',status:'not-run'}]},{...report,cases:[...report.cases,...report.cases]}])assert.throws(()=>validateNativeSmoke(changed,{nonce:'test'}));
 assert.throws(()=>validateNativeSmoke(report,{nonce:'test',requiredCases:['shutdown']}),/Missing/);
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
