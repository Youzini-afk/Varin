import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, metadataBytes, verifyMinisign, verifySignedMetadata } from '../../../scripts/desktop-update-signatures.mjs';
import { acceptanceDomains,releaseTargets,recordArtifact,verifyCandidate,assembleRelease,verifyQualification } from './release.mjs';
import { publicKey,signFixture } from './test-fixtures/signing.mjs';

test('real minisign signatures verify payload, authenticated comment, and exact version',()=>{
  const bytes=Buffer.from('signed artifact');const signature=signFixture(bytes);
  assert.equal(verifyMinisign(bytes,signature,publicKey,{version:'1.2.3'}),true);
  assert.throws(()=>verifyMinisign(Buffer.from('tampered'),signature,publicKey),/verification/);
  assert.throws(()=>verifyMinisign(bytes,signature,publicKey,{version:'9.0.0'}),/version/);
  const changed=Buffer.from(Buffer.from(signature,'base64').toString().replace('version:1.2.3','version:9.0.0')).toString('base64');
  assert.throws(()=>verifyMinisign(bytes,changed,publicKey,{version:'9.0.0'}),/verification/);
});
test('metadata canonicalizes nested keys and authenticates changed version, URL, source and architecture',()=>{
  const value={version:'1.2.3',platforms:{'linux-x64':{url:'https://example.org/release',size:2}},varin:{sourceSha:'a'.repeat(40)}};
  const signed={...value,varinSignature:signFixture(metadataBytes(value))};
  assert.equal(verifySignedMetadata(signed,publicKey),signed);
  assert.equal(canonicalJson({z:[1,true,null],a:'中文'}),'{"a":"中文","z":[1,true,null]}');
  for(const change of [v=>v.version='9.0.0',v=>v.platforms['linux-x64'].url='https://attacker.invalid',v=>v.varin.sourceSha='b'.repeat(40),v=>v.platforms['linux-arm64']=v.platforms['linux-x64']]){
    const copy=structuredClone(signed);change(copy);assert.throws(()=>verifySignedMetadata(copy,publicKey),/verification/);
  }
  for(const value of [undefined,NaN,1.5,{'😀':1}])assert.throws(()=>canonicalJson(value));
});
async function fixture(t,version='1.2.3',mode='electron-to-tauri'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-release-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const lock=JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json',import.meta.url),'utf8'));
  const candidate={schema:1,product:'varin-tauri-candidate',version,releaseRef:`v${version}`,sourceSha:'a'.repeat(40),toolingSha:'b'.repeat(40),transition:{mode:'electron-to-tauri',previousElectronVersion:'1.2.2',previousTauriVersion:null},targets:{}};
  const write=async(name,bytes)=>{await fs.writeFile(path.join(root,name),bytes);return recordArtifact(path.join(root,name));};
  for(const target of releaseTargets){
    const suffix=target.startsWith('win32')?'.exe':target.startsWith('darwin')?'.app.tar.gz':'.AppImage';
    const bytes=Buffer.from(`fixture ${target}`);const update=await write(`Varin-${version}-${target}${suffix}`,bytes);update.signature=signFixture(bytes,version);
    const electron=target.startsWith('darwin')?[await write(`Varin-${version}-${target}.dmg`,bytes),await write(`Varin-${version}-${target}.zip`,bytes)]:[update];
    const [platform,architecture]=target.split('-');
    const runtimeManifest=await write(`${target}.runtime.json`,JSON.stringify({product:'varin-tauri-desktop',version:candidate.version,platform,architecture,sources:{sourceSha:candidate.sourceSha,sourceDirty:false},browser:{engine:'CEF',version:lock.version,sourceArchiveSha1:lock.targets[target].sha1},...(mode==='electron-to-tauri'?{legacyElectron:{sourceSha:candidate.sourceSha,protocol:1}}:{})}));
    const engineManifest=await write(`${target}.engine.json`,JSON.stringify({engine:'CEF',architecture,cefVersion:lock.version,sandbox:'required',sourceSha:candidate.sourceSha,sdk:{sha1:lock.targets[target].sha1}}));
    const entry={runtimeManifest,engineManifest,runtimeManifestSha256:runtimeManifest.sha256,engineManifestSha256:engineManifest.sha256,update,electron};
    const evidence=await write(`${target}.evidence.txt`,'Synthetic unit fixture, not platform acceptance.');
    const receipt={schema:1,target,sourceSha:candidate.sourceSha,version:candidate.version,runtimeManifestSha256:entry.runtimeManifestSha256,engineManifestSha256:entry.engineManifestSha256,
      artifacts:Object.fromEntries([update,...electron].map(file=>[file.name,file.sha256])),results:acceptanceDomains.map(domain=>({domain,status:'passed',procedure:'Synthetic unit verifier fixture only',evidence}))};
    const {performanceFixture}=await import('./test-fixtures/performance.mjs');
    receipt.results.find(result=>result.domain==='resource-performance').evidence=await write(`${target}.performance.json`,JSON.stringify(performanceFixture(receipt)));
    entry.acceptance=await write(`${target}.acceptance.json`,JSON.stringify(receipt));candidate.targets[target]=entry;
  }
  return{root,candidate,write};
}
test('six-target candidate emits two non-interchangeable feeds and signed exact-runtime qualification',async t=>{
  const{root,candidate}=await fixture(t);const output=path.join(root,'output');
  const{feed,qualification}=await assembleRelease(root,candidate,{publicKey,output,sign:signFixture,date:'2026-11-03T00:00:00Z'});
  assert.deepEqual(Object.keys(feed.platforms),releaseTargets);
  const legacy=await fs.readFile(path.join(output,'latest-arm64.yml'),'utf8');
  assert.match(legacy,/win32-arm64.exe/u);assert.doesNotMatch(legacy,/tauri-v1.json|win32-x64/u);
  assert.match(await fs.readFile(path.join(output,'latest-mac.yml'),'utf8'),/darwin-x64.zip/u);
  await verifyQualification(qualification,{publicKey,platform:'linux',architecture:'x64',runtimeManifestSha256:candidate.targets['linux-x64'].runtimeManifestSha256});
  await assert.rejects(verifyQualification(qualification,{publicKey,platform:'linux',architecture:'x64',runtimeManifestSha256:'e'.repeat(64)}),/exact runtime/);
});
test('missing architecture, changed source, missing real evidence, and tampered bytes reject the candidate',async t=>{
  const{root,candidate}=await fixture(t);
  const missing=structuredClone(candidate);delete missing.targets['darwin-x64'];await assert.rejects(verifyCandidate(root,missing,{publicKey}),/Every existing/);
  await assert.rejects(verifyCandidate(root,{...candidate,sourceSha:'b'.repeat(40)},{publicKey}),/source mismatch|another candidate/);
  const target='win32-x64',entry=candidate.targets[target];
  const acceptance=JSON.parse(await fs.readFile(path.join(root,entry.acceptance.name),'utf8'));acceptance.results[0].status='not-run';
  await fs.writeFile(path.join(root,entry.acceptance.name),JSON.stringify(acceptance));entry.acceptance=await recordArtifact(path.join(root,entry.acceptance.name));
  await assert.rejects(verifyCandidate(root,candidate,{publicKey}),/Missing passed startup/);
  await fs.writeFile(path.join(root,candidate.targets['darwin-x64'].update.name),'tampered');
  await assert.rejects(verifyCandidate(root,candidate,{publicKey}),/digest mismatch/);
});

test('collection preserves signed artifacts across six relocated native outputs and refuses unqualified builds',async t=>{
  const{root,candidate}=await fixture(t);
  const {collectCandidate}=await import('./collect-candidate.mjs');
  const inputs={};
  for(const target of releaseTargets){
    const directory=path.join(root,'inputs',target),assets=path.join(directory,'assets');await fs.mkdir(assets,{recursive:true});inputs[target]=directory;
    const entry=candidate.targets[target];
    for(const record of [entry.runtimeManifest,entry.engineManifest,entry.update,...entry.electron])await fs.copyFile(path.join(root,record.name),path.join(assets,record.name));
    const [platform,architecture]=target.split('-');
    await fs.writeFile(path.join(directory,'candidate.json'),JSON.stringify({schema:1,target,sourceSha:candidate.sourceSha,version:candidate.version,
      runtimeManifest:entry.runtimeManifest,engineManifest:entry.engineManifest,
      packaged:{schema:1,product:'varin-tauri-packaged-candidate',mode:'electron-to-tauri',signed:true,platform,architecture,version:candidate.version,runtimeManifestSha256:entry.runtimeManifestSha256,update:entry.update,electron:entry.electron}}));
  }
  const options={inputs,acceptanceDirectory:root,output:path.join(root,'collected'),sourceSha:candidate.sourceSha,toolingSha:candidate.toolingSha,version:candidate.version,transition:candidate.transition,publicKey};
  const actual=await collectCandidate(options);await verifyCandidate(options.output,actual,{publicKey});
  assert.deepEqual(actual,candidate);
  await assert.rejects(collectCandidate(options),/new directory/);
  const buildFile=path.join(inputs['linux-x64'],'candidate.json'),build=JSON.parse(await fs.readFile(buildFile));
  build.packaged.signed=false;await fs.writeFile(buildFile,JSON.stringify(build));
  await assert.rejects(collectCandidate({...options,output:path.join(root,'rejected')}),/exact signed/);
  assert.equal(await fs.stat(path.join(root,'rejected')).then(()=>true,()=>false),false);
});


test('later Tauri releases retain the authenticated original bridge for old Electron installations', async t => {
  const first = await fixture(t);
  const initial = await assembleRelease(first.root, first.candidate, { publicKey, output: path.join(first.root, 'initial'), sign: signFixture, date: '2026-11-03T00:00:00Z' });
  const next = await fixture(t, '1.2.4', 'tauri');
  next.candidate.transition = { mode: 'tauri', previousElectronVersion: '1.2.2', previousTauriVersion: '1.2.3', legacyBridge: initial.bridge };
  const output = path.join(next.root, 'next');
  const result = await assembleRelease(next.root, next.candidate, { publicKey, output, sign: signFixture });
  assert.equal(result.feed.version, '1.2.4');
  assert.match(result.feed.platforms['win32-x64'].url, /v1\.2\.4/u);
  for (const name of ['latest.yml', 'latest-arm64.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']) {
    assert.equal(await fs.readFile(path.join(output, name), 'utf8'), await fs.readFile(path.join(first.root, 'initial', name), 'utf8'));
  }
  assert.equal(result.bridge.version, '1.2.3');
  next.candidate.transition.legacyBridge.feeds['latest.yml'].records[0].url = 'https://attacker.invalid/installer.exe';
  await assert.rejects(verifyCandidate(next.root, next.candidate, { publicKey }), /verification/);
});
