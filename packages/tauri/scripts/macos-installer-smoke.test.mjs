import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from './runtime-manifest.mjs';
import {admitMacCandidate,assertMacState,assertNativeDrain,assertOwnedMount,macProfilePaths,ownsBuildRegistration,requireDisposableMac,runMacInstallationLifecycle,verifyMacEngine} from './macos-installer-smoke.mjs';

async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-macos-install-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function artifact(root,name,bytes){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),bytes);return{name,size:Buffer.byteLength(bytes),sha256:await sha256(path.join(root,name))};}
const home='/Users/ephemeral-runner';
const cleanState=()=>({schema:1,home,applicationSupport:home+'/Library/Application Support',registeredApplications:[],schemeHandler:null,runningApplications:[]});
const nativeObservation=()=>({cleanupUncertain:false,timedOut:false,status:{code:0,signal:null},report:{schema:1,product:'varin-desktop-native-smoke',nonce:'12345678-1234-1234-1234-123456789abc',platform:'darwin',architecture:process.arch,complete:true,cases:[{name:'legacy-native-migration',status:'passed'},{name:'native-drain',status:'passed',evidence:{browserOwnerDrained:true,applicationAndHostScopesEnded:true}}]}});

// These are portable tooling tests. They do not mount, install or launch a Mac app.
test('macOS admission refuses local/self-hosted, wrong OS and redirected user environments',()=>{
  const environment={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'macOS',RUNNER_TEMP:'/private/runner/temp'};
  assert.doesNotThrow(()=>requireDisposableMac({acknowledged:true,environment,platform:'darwin'}));
  for(const changed of [{},{...environment,RUNNER_ENVIRONMENT:'self-hosted'},{...environment,RUNNER_OS:'Linux'},{...environment,RUNNER_TEMP:'relative'},{...environment,CFFIXED_USER_HOME:'/tmp/other'},{...environment,VARIN_DATA_DIR:'/tmp/other'}])assert.throws(()=>requireDisposableMac({acknowledged:true,environment:changed,platform:'darwin'}));
  assert.throws(()=>requireDisposableMac({environment,platform:'darwin'}),/ephemeral/);
  assert.throws(()=>requireDisposableMac({acknowledged:true,environment,platform:'linux'}),/native macOS/);
});

test('macOS registration observations reject existing/default/running owners and never adopt another path',()=>{
  assert.doesNotThrow(()=>assertMacState(cleanState(),{home,requireEmpty:true}));
  const app='/private/runner/smoke/Installed Varin/Varin.app';
  const installed={...cleanState(),registeredApplications:[app],schemeHandler:'dev.varin.desktop'};
  assert.doesNotThrow(()=>assertMacState(installed,{home,ownedApplications:[app]}));
  for(const state of [installed,{...cleanState(),schemeHandler:'other.application'},{...cleanState(),registeredApplications:['/Applications/Varin.app']},{...cleanState(),runningApplications:[app]},{...cleanState(),registeredApplications:null},{...cleanState(),home:'/Users/other'},{...cleanState(),applicationSupport:'/tmp/profile'},{...cleanState(),schema:undefined}])assert.throws(()=>assertMacState(state,{home,requireEmpty:true}));
  assert.throws(()=>assertMacState({...installed,registeredApplications:[app+'/../Foreign.app']},{home,ownedApplications:[app]}),/existing or foreign/);
  assert.throws(()=>assertMacState({...cleanState(),schemeHandler:'dev.varin.desktop'},{home,ownedApplications:[app]}),/existing or foreign/);
  assert.ok(macProfilePaths(home).includes(home+'/Library/Application Support/Varin'));
  assert.ok(macProfilePaths(home).includes(home+'/Library/Application Support/dev.varin.desktop'));
});

test('a build registration exception is confined to the original candidate output under repository artifacts',()=>{
  const repositoryRoot='/private/checkout',payload='/private/checkout/artifacts/candidate/Varin.app';
  assert.equal(ownsBuildRegistration(payload,payload,{repositoryRoot}),true);
  for(const [app,recorded] of [[payload,'/stale/Varin.app'],['/Applications/Varin.app','/Applications/Varin.app'],['/private/checkout/artifacts-elsewhere/Varin.app','/private/checkout/artifacts-elsewhere/Varin.app'],[payload,payload+'/../Varin.app']])assert.equal(ownsBuildRegistration(app,recorded,{repositoryRoot}),false);
});

test('candidate admission binds actual DMG/ZIP/update bytes and ignores stale payload/assets pointers',async t=>{
  const root=await temporary(t),assets=path.join(root,'assets');await fs.mkdir(assets);
  const sourceSha='a'.repeat(40),architecture='arm64',version='1.0.0';
  const runtimeManifest=await artifact(assets,'darwin-arm64.runtime.json',JSON.stringify({sources:{sourceSha},legacyElectron:{sourceSha},platform:'darwin',architecture,version}));
  const engineManifest=await artifact(assets,'darwin-arm64.engine.json',JSON.stringify({schema:1,engine:'CEF',sandbox:'required',sourceSha,architecture}));
  const dmg=await artifact(assets,'Varin.dmg','actual synthetic dmg bytes'),zip=await artifact(assets,'Varin.zip','actual synthetic zip bytes'),update=await artifact(assets,'Varin.app.tar.gz','actual synthetic tar bytes');
  const candidate={schema:1,target:'darwin-arm64',sourceSha,version,payload:'/unrelated/Varin.app',runtime:'/unrelated/runtime',assets:'/unrelated/assets',runtimeManifest,engineManifest,packaged:{mode:'electron-to-tauri',platform:'darwin',architecture,version,runtimeManifestSha256:runtimeManifest.sha256,electron:[dmg,zip],update}};
  const file=path.join(root,'candidate.json'),write=()=>fs.writeFile(file,JSON.stringify(candidate));await write();
  const admitted=await admitMacCandidate(file,{sourceSha,architecture});
  assert.equal(admitted.installer,path.join(assets,'Varin.dmg'));assert.equal(admitted.candidate.payload,path.join(root,'Varin.app'));assert.equal(admitted.candidate.runtime,path.join(root,'Varin.app/Contents/Resources/runtime'));
  await assert.rejects(admitMacCandidate(file,{sourceSha:'b'.repeat(40),architecture}),/same-SHA/);
  await assert.rejects(admitMacCandidate(file,{sourceSha,architecture:'x64'}),/same-SHA/);
  candidate.packaged.electron=[dmg,dmg];await write();await assert.rejects(admitMacCandidate(file,{sourceSha,architecture}),/unambiguous/);
  candidate.packaged.electron=[dmg,zip];await write();await fs.appendFile(path.join(assets,zip.name),'mutated');await assert.rejects(admitMacCandidate(file,{sourceSha,architecture}),/bytes differ/);
});

test('exact macOS engine inventory verifies files, internal framework links and executable permissions', {skip:process.platform==='win32'},async t=>{
  const root=await temporary(t),app=path.join(root,'Varin.app');await fs.mkdir(app);
  const binary=await artifact(app,'Contents/MacOS/varin','real synthetic executable bytes');await fs.chmod(path.join(app,binary.name),0o755);
  const framework=await artifact(app,'Contents/Frameworks/Test.framework/Versions/A/Test','framework bytes');
  const link='Contents/Frameworks/Test.framework/Versions/Current';await fs.symlink('A',path.join(app,link));
  const engine={files:[{path:binary.name,size:binary.size,sha256:binary.sha256,executable:true},{path:framework.name,size:framework.size,sha256:framework.sha256,executable:false},{path:link,link:'A'}]};
  assert.deepEqual(await verifyMacEngine(app,engine),{filesVerified:3});
  await fs.chmod(path.join(app,binary.name),0o644);await assert.rejects(verifyMacEngine(app,engine),/executable mode/);await fs.chmod(path.join(app,binary.name),0o755);
  await artifact(app,'Contents/unlisted','x');await assert.rejects(verifyMacEngine(app,engine),/unlisted/);await fs.unlink(path.join(app,'Contents/unlisted'));
  await fs.appendFile(path.join(app,framework.name),'changed');await assert.rejects(verifyMacEngine(app,engine),/bytes differ/);await fs.writeFile(path.join(app,framework.name),'framework bytes');
  await fs.unlink(path.join(app,link));await fs.symlink(root,path.join(app,link));await assert.rejects(verifyMacEngine(app,engine),/escaped/);
  const redirect=path.join(root,'redirect.app');await fs.symlink(app,redirect);await assert.rejects(verifyMacEngine(redirect,engine),/redirected/);
});

test('mount evidence requires this exact image, one private mount, same device and both read-only flags',()=>{
  const installer='/private/candidate/assets/Varin.dmg',mountpoint='/private/runner/smoke/dmg';
  const image={'image-path':installer,'system-entities':[{'dev-entry':'/dev/disk9'},{'dev-entry':'/dev/disk9s1','mount-point':mountpoint}]};
  const images={images:[image]},disk={DeviceNode:'/dev/disk9s1',MountPoint:mountpoint,ReadOnlyVolume:true,ReadOnlyMedia:true};
  assert.deepEqual(assertOwnedMount(images,disk,{installer,mountpoint}),{readOnly:true,device:'/dev/disk9s1'});
  for(const altered of [{...disk,ReadOnlyVolume:false},{...disk,ReadOnlyMedia:false},{...disk,DeviceNode:'/dev/disk10s1'},{...disk,MountPoint:'/Volumes/Other'}])assert.throws(()=>assertOwnedMount(images,altered,{installer,mountpoint}));
  for(const altered of [{},{images:[]},{images:[image,image]},{images:[{...image,'image-path':'/other.dmg'}]},{images:[{...image,'system-entities':[...image['system-entities'],{'dev-entry':'/dev/disk9s2','mount-point':'/Volumes/Extra'}]}]}])assert.throws(()=>assertOwnedMount(altered,disk,{installer,mountpoint}));
});

test('shell exit and passed case name cannot replace original native/browser/Host scope completion evidence',()=>{
  assert.doesNotThrow(()=>assertNativeDrain(nativeObservation()));
  for(const change of [observation=>{observation.cleanupUncertain=true;},observation=>{observation.timedOut=true;},observation=>{observation.status.code=1;},observation=>{observation.report.cases[1].evidence.applicationAndHostScopesEnded=false;},observation=>{observation.report.cases[1].evidence.browserOwnerDrained=false;},observation=>{delete observation.report.cases[1].evidence;},observation=>{observation.report.cases.pop();}]){
    const observation=nativeObservation();change(observation);assert.throws(()=>assertNativeDrain(observation));
  }
});

function lifecycleFixture({failAt,incompleteAt}={}){
  const calls=[];
  const operation=name=>async()=>{calls.push(name);if(name===failAt)throw new Error('observed failure or timeout');};
  const operations=Object.fromEntries(['seed','verifySourceBefore','mount','install','replace','unregisterOwned','uninstall','verifySourceAfter','detach','retainSession'].map(name=>[name,operation(name)]));
  operations.cleanup=async()=>{throw new Error('Standalone fixture readback cannot authorize private session cleanup');};
  operations.launch=async restart=>{const name=restart?'reopen':'launch';await operation(name)();const value=nativeObservation();if(incompleteAt===name)value.report.cases[1].evidence.applicationAndHostScopesEnded=false;return value;};
  return{calls,operations};
}
test('installation controller gates replacement/removal on native drain and retains the fixture session after detach',async()=>{
  const success=lifecycleFixture();await runMacInstallationLifecycle(success.operations);
  const ordered=['seed','verifySourceBefore','mount','install','launch','replace','reopen','unregisterOwned','uninstall','verifySourceAfter','detach','retainSession'];
  assert.deepEqual(success.calls,ordered);
  for(const name of ordered){const fixture=lifecycleFixture({failAt:name});await assert.rejects(runMacInstallationLifecycle(fixture.operations),/observed failure/);assert.deepEqual(fixture.calls,ordered.slice(0,ordered.indexOf(name)+1));}
  for(const name of ['launch','reopen']){const fixture=lifecycleFixture({incompleteAt:name});await assert.rejects(runMacInstallationLifecycle(fixture.operations),/terminal evidence/);assert.deepEqual(fixture.calls,ordered.slice(0,ordered.indexOf(name)+1));}
});

test('native macOS state helper returns actual read-only observations', {skip:process.platform!=='darwin'},()=>{
  const value=JSON.parse(execFileSync('/usr/bin/swift',[path.join(import.meta.dirname,'macos-installation-state.swift')],{encoding:'utf8',timeout:60_000}));
  assert.equal(value.schema,1);assert.ok(path.isAbsolute(value.home));assert.ok(Array.isArray(value.registeredApplications));assert.ok(Array.isArray(value.runningApplications));
});

test('native macOS plist projection ignores binary aliases while preserving mount identity', {skip:process.platform!=='darwin'},()=>{
  const input='<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>images</key><array><dict><key>image-path</key><string>/private/candidate/Varin.dmg</string><key>image-alias</key><data>AAEC/w==</data><key>ignored-date</key><date>2026-11-03T00:00:00Z</date><key>system-entities</key><array><dict><key>dev-entry</key><string>/dev/disk9s1</string><key>mount-point</key><string>/private/runner/dmg</string></dict></array></dict></array></dict></plist>';
  const result=JSON.parse(execFileSync('/usr/bin/swift',[path.join(import.meta.dirname,'macos-plist-observation.swift'),'images'],{input,encoding:'utf8',timeout:60_000}));
  assert.deepEqual(result,{images:[{'image-path':'/private/candidate/Varin.dmg','system-entities':[{'dev-entry':'/dev/disk9s1','mount-point':'/private/runner/dmg'}]}]});
});
