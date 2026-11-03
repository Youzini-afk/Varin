import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sha256} from './runtime-manifest.mjs';
import {admitCandidate,assertCleanWindowsState,assertInstalledWindowsState,nsisArguments,requireDisposableRunner,runObserved,verifyInstalledFiles,verifyRecord} from './installer-smoke.mjs';

async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-installer-tooling-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function artifact(root,name,bytes){await fs.writeFile(path.join(root,name),bytes);return{name,size:Buffer.byteLength(bytes),sha256:await sha256(path.join(root,name))};}

test('real installers refuse local, self-hosted and unacknowledged environments before mutation',()=>{
  const environment={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:'private'};
  assert.doesNotThrow(()=>requireDisposableRunner({acknowledged:true,environment,platform:'win32'}));
  for(const changed of [{},{...environment,RUNNER_ENVIRONMENT:'self-hosted'},{...environment,RUNNER_TEMP:''}])assert.throws(()=>requireDisposableRunner({acknowledged:true,environment:changed,platform:'win32'}));
  assert.throws(()=>requireDisposableRunner({environment,platform:'win32'}),/ephemeral/);
  assert.throws(()=>requireDisposableRunner({acknowledged:true,environment,platform:'darwin'}),/supports/);
});
test('NSIS preserves original current-user and keep-data modes with an unquoted final path',()=>{
  const directory='C:\\Users\\runner\\Temp\\Installed Varin';
  assert.deepEqual(nsisArguments(directory),['/S','/currentuser',`/D=${directory}`]);
  assert.deepEqual(nsisArguments(directory,{uninstall:true}),['/S','/currentuser','/KEEP_APP_DATA',`_?=${directory}`]);
  for(const value of ['relative','C:\\bad"name','C:\\bad\nname'])assert.throws(()=>nsisArguments(value));
});
test('process observation executes actual subprocess effects and fails on exit error or timeout',async t=>{
  const root=await temporary(t),file=path.join(root,'actual-child.txt');
  const result=await runObserved(process.execPath,['-e','require("fs").writeFileSync(process.argv[1],"actual-child-effect")',file]);
  assert.equal(result.code,0);assert.equal(await fs.readFile(file,'utf8'),'actual-child-effect');
  await assert.rejects(runObserved(process.execPath,['-e','process.exit(3)']),/Process failed \(3\)/);
  await assert.rejects(runObserved(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100}),error=>error.observed?.timedOut===true);
});
test('same-source admission reads real artifact bytes and refuses another target, generation or installer',async t=>{
  const root=await temporary(t),assets=path.join(root,'assets');await fs.mkdir(assets);
  const sourceSha='a'.repeat(40),platform='win32',architecture='x64';
  const runtimeManifest=await artifact(assets,'win32-x64.runtime.json',JSON.stringify({sources:{sourceSha},legacyElectron:{sourceSha},platform,architecture}));
  const engineManifest=await artifact(assets,'win32-x64.engine.json',JSON.stringify({sourceSha,architecture}));
  const installer=await artifact(assets,'Varin-fixture.exe','synthetic artifact bytes, not an installer');
  const candidate={schema:1,target:'win32-x64',sourceSha,version:'1.0.0',assets:'/ignored-stale-build-path',runtimeManifest,engineManifest,
    packaged:{mode:'electron-to-tauri',platform,architecture,version:'1.0.0',runtimeManifestSha256:runtimeManifest.sha256,electron:[installer],update:installer}};
  const candidateFile=path.join(root,'candidate.json');await fs.writeFile(candidateFile,JSON.stringify(candidate));
  assert.equal((await admitCandidate(candidateFile,{sourceSha,platform,architecture})).installer,path.join(assets,installer.name));
  await assert.rejects(admitCandidate(candidateFile,{sourceSha:'b'.repeat(40),platform,architecture}),/same-SHA/);
  await assert.rejects(admitCandidate(candidateFile,{sourceSha,platform,architecture:'arm64'}),/same-SHA/);
  await fs.appendFile(path.join(assets,installer.name),'changed');
  await assert.rejects(admitCandidate(candidateFile,{sourceSha,platform,architecture}),/bytes differ/);
  await assert.rejects(verifyRecord(assets,{...installer,name:'../elsewhere.exe'}),/invalid/);
});
test('installed inventory checks actual files, including mutation, duplication and outside links',async t=>{
  const root=await temporary(t),directory=path.join(root,'app');await fs.mkdir(directory);
  const file=await artifact(directory,'varin.exe','exact native fixture bytes');
  const entry={path:file.name,size:file.size,sha256:file.sha256};
  assert.deepEqual(await verifyInstalledFiles(directory,{files:[entry]}),{filesVerified:1});
  await assert.rejects(verifyInstalledFiles(directory,{files:[entry,entry]}),/duplicate/);
  await fs.writeFile(path.join(directory,'varin.exe'),'different native generation');
  await assert.rejects(verifyInstalledFiles(directory,{files:[entry]}),/bytes differ/);
  await assert.rejects(verifyInstalledFiles(directory,{files:[{...entry,path:'../outside'}]}),/relative path/);
  if(process.platform!=='win32'){
    await fs.writeFile(path.join(root,'outside'),'x');await fs.symlink('../outside',path.join(directory,'escape'));
    await assert.rejects(verifyInstalledFiles(directory,{files:[{path:'escape',link:'../outside'}]}),/escaped/);
  }
});
test('Windows admission refuses prior registrations and verifies owned per-user registration and shortcuts',()=>{
  const clean={appData:'C:\\Users\\runner\\AppData\\Roaming',installations:[],uninstall:[],protocol:[],notifications:[],shortcuts:[]};
  assert.doesNotThrow(()=>assertCleanWindowsState(clean));
  for(const key of ['installations','uninstall','protocol','notifications','shortcuts'])assert.throws(()=>assertCleanWindowsState({...clean,[key]:[{}]}),/existing/);
  const directory='C:\\Temp\\Installed Varin',executable=path.win32.join(directory,'varin.exe');
  const installed={...clean,installations:[{hive:'HKCU',location:directory}],uninstall:[{hive:'HKCU',version:'1.0.0'}],notifications:[{hive:'HKCU'},{hive:'HKCU'}],protocol:[{hive:'HKCU',owner:executable,command:`"${executable}" "%1"`}],shortcuts:[{target:executable}]};
  assert.doesNotThrow(()=>assertInstalledWindowsState(installed,directory,'1.0.0'));
  assert.throws(()=>assertInstalledWindowsState({...installed,uninstall:[{...installed.uninstall[0],hive:'HKLM'}]},directory,'1.0.0'),/per-user/);
  assert.throws(()=>assertInstalledWindowsState({...installed,protocol:[{...installed.protocol[0],command:'other.exe "%1"'}]},directory,'1.0.0'),/URL/);
  assert.throws(()=>assertInstalledWindowsState({...installed,shortcuts:[{target:'C:\\Other\\varin.exe'}]},directory,'1.0.0'),/shortcuts/);
});
