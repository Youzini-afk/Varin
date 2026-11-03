import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {admitApplicationFixtureSession,applicationFixtureApi,readApplicationFixture,runInstalledDataFixture,applicationFixtureFile} from './installed-data-fixture.mjs';

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
  const seen=[];const server=http.createServer((req,res)=>{seen.push({route:req.url,authorization:req.headers.authorization,method:req.method});if(req.url==='/api/models/read'){res.writeHead(302,{location:'https://external.invalid'});res.end();return;}res.setHeader('content-type','application/json');res.end('{"fontSize":113}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const api=applicationFixtureApi(`http://127.0.0.1:${server.address().port}`,'fixture-token');assert.deepEqual(await api('/api/config/settings'),{fontSize:113});
  assert.deepEqual(seen,[{route:'/api/config/settings',authorization:'Bearer fixture-token',method:'GET'}]);
  await assert.rejects(api('/api/arbitrary',{}),/Unsupported/);await assert.rejects(api('/api/models/read',{}));
  for(const origin of ['http://localhost:123','https://127.0.0.1:123','http://user@127.0.0.1:123','http://127.0.0.1:123/foreign'])assert.throws(()=>applicationFixtureApi(origin,'token'),/loopback/);
});
test('a missing or extra-data marker cannot authorize reopening a private session',async t=>{
  const s=await session(t),nonce=randomUUID(),candidate={sourceSha:'a'.repeat(40),version:'0.9.37'};
  await assert.rejects(readApplicationFixture(s,nonce,candidate),{code:'ENOENT'});
  await fs.writeFile(path.join(s.data,applicationFixtureFile),JSON.stringify({schema:1,nonce,complete:true,ownerStopped:true,secret:'never-export'}));
  await assert.rejects(readApplicationFixture(s,nonce,candidate),/incomplete/);
});

// This opt-in test executes the real bundled production Host, Rust runtime and
// credential/settings owners. The normal installer suite runs the same helper.
// Portable admission tests above never stand in for this native evidence.
test('bundled owners preserve real completed chat, project, settings and synthetic auth after full shutdown/reopen',{skip:!process.env.VARIN_INSTALLED_DATA_RUNTIME,timeout:300_000},async t=>{
  const runtime=path.resolve(process.env.VARIN_INSTALLED_DATA_RUNTIME),manifest=JSON.parse(await fs.readFile(path.join(runtime,'runtime-manifest.json'),'utf8'));
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-'))),s={root,data:path.join(root,'data'),home:path.join(root,'home')};await fs.mkdir(s.data);await fs.mkdir(s.home);
  const nonce=randomUUID(),candidate={runtime,sourceSha:manifest.sources.sourceSha,version:manifest.version};let drained=false;
  try{
    const seeded=await runInstalledDataFixture('seed',candidate,s,nonce);assert.equal(seeded.ownerStopped,true);
    const reopened=await runInstalledDataFixture('verify',candidate,s,nonce);drained=true;
    for(const key of ['chatHistoryPreserved','completedRunPreserved','projectRegistrationPreserved','hostSettingsPreserved','modelCredentialBindingPreserved','credentialValueAndIdentityPreserved','desktopInstallIdPreserved','desktopPreferencePreserved','projectFilePreserved','ownerStopped'])assert.equal(reopened[key],true,key);
    const encoded=JSON.stringify({seeded,reopened});assert.equal(encoded.includes(nonce),false);assert.equal(encoded.includes('fixture-only:'),false);assert.equal(encoded.includes('Synthetic installer preservation'),false);
    const receipt=await readApplicationFixture(s,nonce,candidate);assert.ok(receipt.sha256);await assert.rejects(readApplicationFixture(s,randomUUID(),candidate),/another invocation/);
  }finally{if(drained)await fs.rm(root,{recursive:true,force:true});else t.diagnostic('Unconfirmed private native fixture retained; no automatic data cleanup.');}
});
