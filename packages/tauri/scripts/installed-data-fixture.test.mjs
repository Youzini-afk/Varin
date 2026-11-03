import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {runApplicationFixtureProcess,admitApplicationFixtureSession,applicationFixtureApi,readApplicationFixture,runInstalledDataFixture,applicationFixtureFile,applicationFixtureOrigin,verifyApplicationFixtureBrowserBoundary} from './installed-data-fixture.mjs';
import {claimSmokeSession,releaseSmokeSession} from './smoke-session.mjs';
import {launchOwned,prepareNativeProcessOwner} from './native-process-owner.mjs';
import {fileURLToPath} from 'node:url';

async function session(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-')));const value={root,data:path.join(root,'data'),home:path.join(root,'home')};await fs.mkdir(value.data);await fs.mkdir(value.home);t.after(()=>fs.rm(root,{recursive:true,force:true}));return value;}
test('application-data seeding admits only a new nonce-bound native smoke session',async t=>{
  const s=await session(t),nonce=randomUUID();assert.equal(await admitApplicationFixtureSession(s,nonce,{seed:true}),await fs.realpath(s.root));
  await fs.writeFile(path.join(s.data,'existing-settings.json'),'untouched');
  await assert.rejects(admitApplicationFixtureSession(s,nonce,{seed:true}),/existing data/);
  await assert.rejects(admitApplicationFixtureSession({...s,data:s.root},nonce),/temporary session/);
  await assert.rejects(admitApplicationFixtureSession(s,'arbitrary'),/nonce/);
  assert.equal(await fs.readFile(path.join(s.data,'existing-settings.json'),'utf8'),'untouched');
});
test('application fixture refuses redirected and unowned directories before owner startup',{skip:process.platform==='win32'},async t=>{
  const s=await session(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'varin-unrelated-data-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.rmdir(s.data);await fs.symlink(outside,s.data);
  await assert.rejects(admitApplicationFixtureSession(s,randomUUID(),{seed:true}),/redirected/);
  assert.deepEqual(await fs.readdir(outside),[]);
});
test('fixture API uses actual authenticated loopback requests and rejects other routes and redirects',async t=>{
  const seen=[];const server=http.createServer((req,res)=>{seen.push({route:req.url,authorization:req.headers.authorization,method:req.method,origin:req.headers.origin});if(req.url==='/api/models/read'){res.writeHead(302,{location:'https://external.invalid'});res.end();return;}res.setHeader('access-control-allow-origin',applicationFixtureOrigin);res.setHeader('content-type','application/json');res.end('{"fontSize":113}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const api=applicationFixtureApi(`http://127.0.0.1:${server.address().port}`,'fixture-token');assert.deepEqual(await api('/api/config/settings'),{fontSize:113});
  assert.deepEqual(seen,[{route:'/api/config/settings',authorization:'Bearer fixture-token',method:'GET',origin:applicationFixtureOrigin}]);
  await assert.rejects(api('/api/arbitrary',{}),/Unsupported/);await assert.rejects(api('/api/models/read',{}));
  for(const origin of ['http://localhost:123','https://127.0.0.1:123','http://user@127.0.0.1:123','http://127.0.0.1:123/foreign'])assert.throws(()=>applicationFixtureApi(origin,'token'),/loopback/);
});
test('Node fixture refuses a readable HTTP result that the packaged browser cannot access',async t=>{
  const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await assert.rejects(applicationFixtureApi(origin,'fixture-token')('/api/config/settings'),/renderer origin/);
  await assert.rejects(verifyApplicationFixtureBrowserBoundary(origin),/preflight/);
  await assert.rejects(verifyApplicationFixtureBrowserBoundary('http://localhost:123'),/original loopback/);
});
test('a missing or extra-data marker cannot authorize reopening a private session',async t=>{
  const s=await session(t),nonce=randomUUID(),candidate={sourceSha:'a'.repeat(40),version:'0.9.37'};
  await assert.rejects(readApplicationFixture(s,nonce,candidate),{code:'ENOENT'});
  await fs.writeFile(path.join(s.data,applicationFixtureFile),JSON.stringify({schema:1,nonce,complete:true,ownerStopped:true,secret:'never-export'}));
  await assert.rejects(readApplicationFixture(s,nonce,candidate),/incomplete/);
});

const supported=['linux','win32'].includes(process.platform);
const native={skip:!supported,timeout:30_000};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=file=>fs.stat(file).then(()=>true,()=>false);
const count=file=>fs.readFile(file,'utf8').then(text=>text.length,()=>0);
async function waitFor(predicate){const end=Date.now()+10_000;while(!await predicate()){if(Date.now()>end)throw new Error('Private process fixture did not reach its expected state');await sleep(10);}}
const primitiveCandidate={sourceSha:'a'.repeat(40),version:'0.9.37'};
// These are deliberately trivial application-process records, NOT Host/kernel
// proof. Only the real native guardian supplies ownership receipts in this suite.
const semanticResult={mode:'seed',chatHistoryPreserved:true,completedRunPreserved:true,projectRegistrationPreserved:true,hostSettingsPreserved:true,modelCredentialBindingPreserved:true,packagedOriginPreflightVerified:true,anonymousHostAccessRejected:true,anonymousUrlTokenRejected:true,unrelatedOriginRejected:true,credentialValueAndIdentityPreserved:true,desktopInstallIdPreserved:true,desktopPreferencePreserved:true,projectFilePreserved:true,ownerStopped:true,provider:'controlled-loopback-only',valuesDisclosed:false};
const detachedWriter=`const fs=require('fs');const path=require('path');const root=process.argv[1];
process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(root,'writer-ready'),'ready');
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'writer-stop'))){clearInterval(timer);fs.writeFileSync(path.join(root,'writer-ended'),'ended');return;}fs.appendFileSync(path.join(root,'writes'),'x');},10);`;
async function processFixture(t,{behavior='',detached=false,retain=false}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-'))),s={root,data:path.join(root,'data'),home:path.join(root,'home')};await fs.mkdir(s.data);await fs.mkdir(s.home);
  // Cleanup is registered separately by each test, only after known native drain.
  const workerEntry=path.join(root,'primitive-worker.mjs');
  await fs.writeFile(workerEntry,`import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
const [,root,nonce,launchId]=process.argv.slice(2),directory=path.join(root,'.application-fixture-'+launchId);
const request=JSON.parse(await fs.readFile(path.join(directory,'request.json'),'utf8'));
let value={schema:1,product:request.product,launchId,nonce,mode:request.mode,ok:true,result:${JSON.stringify(semanticResult)}};
${detached?`const child=spawn(process.execPath,['-e',${JSON.stringify(detachedWriter)},root],{detached:true,stdio:'ignore'});child.unref();`:''}
${behavior}
if(value)await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(value),{flag:'wx',mode:0o600});
await fs.writeFile(path.join(root,'root-ended'),'ended');
`,{mode:0o600});
  const nonce=randomUUID();
  const input={mode:'seed',candidate:primitiveCandidate,session:s,nonce,runtime:root};
  const options={workerEntry,prepareLaunch:async()=>({executable:process.execPath,env:{...process.env}})};
  return{s,input,options,async cleanup(){if(!retain)await fs.rm(root,{recursive:true,force:true});}};
}

test('a successful root and semantic JSON cannot release a live detached writer or admit the next fixture',native,async t=>{
  const f=await processFixture(t,{detached:true});let settled=false;
  const pending=runApplicationFixtureProcess(f.input,{...f.options,timeoutMs:15_000}).then(value=>{settled=true;return value;});
  try{
    await waitFor(()=>exists(path.join(f.s.root,'writer-ready')));await waitFor(()=>exists(path.join(f.s.root,'root-ended')));
    const before=await count(path.join(f.s.root,'writes'));await sleep(120);
    assert.ok(await count(path.join(f.s.root,'writes'))>before);assert.equal(settled,false);
    assert.throws(()=>claimSmokeSession(f.s),/active or unconfirmed/);
    await assert.rejects(runInstalledDataFixture('verify',primitiveCandidate,f.s,f.input.nonce,{runtime:f.s.root}),/active or unconfirmed/);
    await fs.writeFile(path.join(f.s.root,'writer-stop'),'stop');
    const result=await pending;
    assert.deepEqual([result.ownerStopped,result.processOwnership.ownershipDrainConfirmed,result.processOwnership.clean,result.processOwnership.forced],[true,true,true,false]);
    assert.equal(JSON.stringify(result).includes(f.input.nonce),false);assert.equal(JSON.stringify(result).includes(f.s.root),false);
    const lease=claimSmokeSession(f.s);releaseSmokeSession(lease);
  }finally{await fs.writeFile(path.join(f.s.root,'writer-stop'),'stop');await pending;await f.cleanup();}
});

test('forced original-scope cleanup stops real writes but permanently fails and blocks reopen',native,async t=>{
  const f=await processFixture(t,{detached:true});
  const pending=runApplicationFixtureProcess(f.input,{...f.options,timeoutMs:1000,cleanupTimeoutMs:10_000});
  // Register rejection immediately, even while waiting for its actual descendant.
  const failure=pending.then(()=>assert.fail('Forced cleanup must not pass the fixture'),error=>error);
  await waitFor(()=>exists(path.join(f.s.root,'writer-ready')));
  const error=await failure;
  assert.equal(error.cleanupUncertain,true);
  assert.deepEqual([error.processOwnership.ownershipDrainConfirmed,error.processOwnership.clean,error.processOwnership.forced],[true,false,true]);
  const after=await count(path.join(f.s.root,'writes'));await sleep(100);assert.equal(await count(path.join(f.s.root,'writes')),after);
  assert.throws(()=>claimSmokeSession(f.s),/active or unconfirmed/);
  await assert.rejects(runInstalledDataFixture('verify',primitiveCandidate,f.s,f.input.nonce,{runtime:f.s.root}),/active or unconfirmed/);
  await assert.rejects(runApplicationFixtureProcess(f.input,f.options),/active or unconfirmed/);
  assert.equal(JSON.stringify(error).includes(f.s.root),false);await f.cleanup();
});

test('an unknown original-scope deadline retains private files and blocks all subsequent owners while writes continue',native,async t=>{
  const f=await processFixture(t,{detached:true,retain:true});
  const failure=runApplicationFixtureProcess(f.input,{...f.options,timeoutMs:1000,cleanupTimeoutMs:0}).then(()=>assert.fail('Unknown scope must not pass'),error=>error);
  await waitFor(()=>exists(path.join(f.s.root,'writer-ready')));
  const error=await failure;
  assert.equal(error.cleanupUncertain,true);assert.equal(error.processOwnership.ownershipDrainConfirmed,false);
  const before=await count(path.join(f.s.root,'writes'));await sleep(100);assert.ok(await count(path.join(f.s.root,'writes'))>before);
  assert.throws(()=>claimSmokeSession(f.s),/active or unconfirmed/);
  await assert.rejects(runInstalledDataFixture('verify',primitiveCandidate,f.s,f.input.nonce,{runtime:f.s.root}),/active or unconfirmed/);
  await fs.writeFile(path.join(f.s.root,'writer-stop'),'stop');await waitFor(()=>exists(path.join(f.s.root,'writer-ended')));
  assert.equal(await exists(f.s.data),true);
  t.diagnostic('The observation remained unknown, so its private fixture is retained even after the test writer acknowledges shutdown.');
});

for(const [name,behavior] of [
  ['missing result','value=null;'],
  ['stale launch result',"value.launchId='00000000-0000-4000-8000-000000000000';"],
  ['stale nonce',"value.nonce='00000000-0000-4000-8000-000000000000';"],
  ['failed semantic owner stop','value.result.ownerStopped=false;'],
  ['extra secret field',"value.result.secret='synthetic-private-value';"],
  ['oversized result',"value.result.secret='x'.repeat(17000);"],
])test(`native clean exit alone cannot admit ${name}`,native,async t=>{
  const f=await processFixture(t,{behavior});
  const error=await runApplicationFixtureProcess(f.input,f.options).then(()=>assert.fail('Invalid app record must not pass'),error=>error);
  assert.deepEqual([error.cleanupUncertain,error.processOwnership.ownershipDrainConfirmed,error.processOwnership.clean],[true,true,true]);
  assert.throws(()=>claimSmokeSession(f.s),/active or unconfirmed/);
  assert.equal(String(error).includes('synthetic-private-value'),false);await f.cleanup();
});

test('the fixture captures immutable session paths before asynchronous validation and keeps the original lease',native,async t=>{
  const f=await processFixture(t,{detached:true}),original={...f.s},other=await session(t);
  const pending=runApplicationFixtureProcess(f.input,{...f.options,timeoutMs:15_000});
  Object.assign(f.s,other);
  try{
    await waitFor(()=>exists(path.join(original.root,'writer-ready')));
    assert.equal(await exists(path.join(other.root,'writer-ready')),false);
    assert.throws(()=>claimSmokeSession(original),/active or unconfirmed/);
    const otherLease=claimSmokeSession(other);releaseSmokeSession(otherLease);
    await fs.writeFile(path.join(original.root,'writer-stop'),'stop');assert.equal((await pending).processOwnership.clean,true);
  }finally{await fs.writeFile(path.join(original.root,'writer-stop'),'stop');await pending;await f.cleanup();}
});

test('a copied application marker does not provide the private successful generation required to reopen',{skip:!supported},async t=>{
  const s=await session(t),nonce=randomUUID();
  await fs.writeFile(path.join(s.data,applicationFixtureFile),JSON.stringify({complete:true,ownerStopped:true,nonce}));
  const error=await runInstalledDataFixture('verify',primitiveCandidate,s,nonce,{runtime:s.root}).then(()=>assert.fail('Copied marker must not authorize execution'),error=>error);
  assert.equal(error.notExecuted,true);assert.equal(error.execution,'not-executed');assert.equal(error.processOwnership,null);
  const lease=claimSmokeSession(s);releaseSmokeSession(lease); // Refused before an owner or lease existed.
});

async function completedBoundaryGeneration(t){
  const f=await processFixture(t);
  // A deliberately invalid product marker exercises only private generation
  // admission. The installed-product validator never accepts this test record.
  const validateResult=async()=>{const bytes='{}';await fs.writeFile(path.join(f.s.data,applicationFixtureFile),bytes);return{sha256:createHash('sha256').update(bytes).digest('hex')};};
  assert.equal((await runApplicationFixtureProcess(f.input,{...f.options,validateResult})).processOwnership.clean,true);
  return f;
}

test('only the exact original session can consume a generation, and duplicate verify fails before the first await',native,async t=>{
  const f=await completedBoundaryGeneration(t);
  const clone={...f.s};
  await assert.rejects(runInstalledDataFixture('verify',primitiveCandidate,clone,f.input.nonce,{runtime:f.s.root}),/original session generation/);
  const verify={...f.input,mode:'verify'};
  const first=runApplicationFixtureProcess(verify,f.options);
  const firstFailure=first.then(()=>assert.fail('The boundary-only marker is not product evidence'),error=>error);
  await assert.rejects(runApplicationFixtureProcess(verify,f.options),/original session generation/);
  assert.match((await firstFailure).message,/failed at admission/);
  await assert.rejects(runApplicationFixtureProcess(verify,f.options),/original session generation/);
  assert.throws(()=>claimSmokeSession(f.s),/active or unconfirmed/);await f.cleanup();
});

for(const mismatch of ['paths','candidate','nonce'])test(`a changed ${mismatch} cannot reuse or restore the original fixture generation`,native,async t=>{
  const f=await completedBoundaryGeneration(t),original={...f.s},other=await session(t);
  if(mismatch==='paths')Object.assign(f.s,other);
  const candidate=mismatch==='candidate'?{...primitiveCandidate,sourceSha:'b'.repeat(40)}:primitiveCandidate;
  const nonce=mismatch==='nonce'?randomUUID():f.input.nonce;
  await assert.rejects(runInstalledDataFixture('verify',candidate,f.s,nonce,{runtime:original.root}),/original session generation/);
  Object.assign(f.s,original);
  await assert.rejects(runInstalledDataFixture('verify',primitiveCandidate,f.s,f.input.nonce,{runtime:original.root}),/original session generation/);
  await f.cleanup();
});

test('worker refuses a redirected private request without starting product owners',native,async t=>{
  const s=await session(t),nonce=randomUUID(),launchId=randomUUID(),directory=path.join(s.root,`.application-fixture-${launchId}`);
  await fs.mkdir(directory,{mode:0o700});
  // An exact filename is insufficient: a directory in place of the bounded
  // regular request is rejected before any provider/Host/kernel can be started.
  await fs.mkdir(path.join(directory,'request.json'));
  const helperExecutable=await prepareNativeProcessOwner();
  const owner=await launchOwned({executable:process.execPath,args:[fileURLToPath(new URL('./installed-data-fixture.mjs',import.meta.url)),'--application-fixture-worker',s.root,nonce,launchId],env:{...process.env}},{helperExecutable});
  const result=await owner.settle({timeoutMs:10_000});assert.equal(result.ownershipDrainConfirmed,true);assert.equal(result.rootExit.code,1);
  assert.equal(await exists(path.join(directory,'result.json')),false);assert.deepEqual(await fs.readdir(s.data),[]);
});

test('unsupported macOS fixture reports not-executed before inspecting or starting a runtime',{skip:process.platform!=='darwin'},async()=>{
  const error=await runInstalledDataFixture('seed',primitiveCandidate,{root:'/not-a-private-session'},randomUUID(),{runtime:'/must-not-start'}).then(()=>assert.fail('Unsupported scope must fail closed'),error=>error);
  assert.equal(error.notExecuted,true);assert.equal(error.execution,'not-executed');assert.equal(error.processOwnership,null);
});

// This opt-in test executes the real bundled production Host, Rust runtime and
// credential/settings owners. The normal installer suite runs the same helper.
// Portable admission tests above never stand in for this native evidence.
test('bundled owners preserve real completed chat, project, settings and synthetic auth after full shutdown/reopen',{skip:!supported?'not-executed: full descendant ownership is unsupported on this platform':!process.env.VARIN_INSTALLED_DATA_RUNTIME,timeout:300_000},async t=>{
  const runtime=path.resolve(process.env.VARIN_INSTALLED_DATA_RUNTIME),manifest=JSON.parse(await fs.readFile(path.join(runtime,'runtime-manifest.json'),'utf8'));
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-'))),s={root,data:path.join(root,'data'),home:path.join(root,'home')};await fs.mkdir(s.data);await fs.mkdir(s.home);
  const nonce=randomUUID(),candidate={runtime,sourceSha:manifest.sources.sourceSha,version:manifest.version};let drained=false;
  try{
    const seeded=await runInstalledDataFixture('seed',candidate,s,nonce);assert.equal(seeded.ownerStopped,true);
    const reopened=await runInstalledDataFixture('verify',candidate,s,nonce);drained=true;
    for(const key of ['chatHistoryPreserved','completedRunPreserved','projectRegistrationPreserved','hostSettingsPreserved','modelCredentialBindingPreserved','credentialValueAndIdentityPreserved','desktopInstallIdPreserved','desktopPreferencePreserved','projectFilePreserved','ownerStopped','packagedOriginPreflightVerified','anonymousHostAccessRejected','anonymousUrlTokenRejected','unrelatedOriginRejected'])assert.equal(reopened[key],true,key);
    const encoded=JSON.stringify({seeded,reopened});assert.equal(encoded.includes(nonce),false);assert.equal(encoded.includes('fixture-only:'),false);assert.equal(encoded.includes('Synthetic installer preservation'),false);
    const receipt=await readApplicationFixture(s,nonce,candidate);assert.ok(receipt.sha256);await assert.rejects(readApplicationFixture(s,randomUUID(),candidate),/another invocation/);
  }finally{if(drained)await fs.rm(root,{recursive:true,force:true});else t.diagnostic('Unconfirmed private native fixture retained; no automatic data cleanup.');}
});
