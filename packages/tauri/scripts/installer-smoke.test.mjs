import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sha256} from './runtime-manifest.mjs';
import {admitCandidate,assertCleanWindowsState,assertInstalledWindowsState,nsisArguments,requireDisposableRunner,runObserved,verifyInstalledFiles,verifyRecord,preflightFixture} from './installer-smoke.mjs';
import {createStartupClassifier,readLinuxStartupState} from './linux-startup-diagnostics.mjs';

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
test('startup observation exports fixed signatures, never raw stderr, stdout, argv or environment',async()=>{
  const privateValue='private-page-credential-and-path';
  const script=`process.stdout.write(${JSON.stringify(privateValue)});process.stderr.write(${JSON.stringify(privateValue+'\nNo usable sandbox!\nFailed to move to new namespace: Operation not permitted\n')});process.exitCode=7;`;
  await assert.rejects(runObserved(process.execPath,['-e',script,privateValue],{startupDiagnostics:true,env:{...process.env,PRIVATE_FIXTURE:privateValue}}),error=>{
    assert.equal(error.message,'Process failed (7)');
    assert.deepEqual(error.observed,{code:7,signal:null,timedOut:false,startupSignatures:['no-usable-sandbox','namespace-denied']});
    assert.equal(JSON.stringify(error).includes(privateValue),false);return true;
  });
  const unknown=await runObserved(process.execPath,['-e',`process.stderr.write(${JSON.stringify(privateValue)})`],{startupDiagnostics:true});
  assert.deepEqual(unknown.startupSignatures,[]);
  const ignored=await runObserved(process.execPath,['-e','process.stderr.write("No usable sandbox!")']);
  assert.equal('startupSignatures' in ignored,false);
});
test('startup classifier handles split signatures and large unrelated output without exposing text',()=>{
  const classifier=createStartupClassifier();
  classifier.write('unrelated-secret'.repeat(100_000));
  for(const character of 'The SUID sandbox helper binary was found, but is not configured correctly.\nMissing X server or $DISPLAY\n/private/electron: error while loading shared libraries: private.so: cannot open shared object file: No such file or directory\n')classifier.write(character);
  assert.deepEqual(classifier.finish(),['suid-sandbox-helper','missing-display','missing-shared-library']);
  const unknown=createStartupClassifier();unknown.write('namespace sandbox display library private secret');
  assert.deepEqual(unknown.finish(),[]);
});
test('Linux startup state accepts only fixed values and distinguishes missing, denied and unrecognized',async()=>{
  const read=async file=>{
    if(file.endsWith('/unprivileged_userns_clone'))return '1';
    if(file.endsWith('/max_user_namespaces'))return '12345';
    if(file.endsWith('/apparmor_restrict_unprivileged_userns'))throw Object.assign(new Error('private-error'),{code:'ENOENT'});
    if(file.endsWith('/apparmor_restrict_unprivileged_unconfined'))throw Object.assign(new Error('private-error'),{code:'EACCES'});
    if(file.endsWith('/enabled'))return 'private-value';
    if(file.endsWith('/current'))return 'private-container-label (enforce)';
    throw new Error('Unexpected state read');
  };
  const state=await readLinuxStartupState({read});
  assert.deepEqual(state,{
    unprivilegedUsernsClone:{status:'observed',value:1},maxUserNamespaces:{status:'observed',value:12345},
    apparmorRestrictUnprivilegedUserns:{status:'missing'},apparmorRestrictUnprivilegedUnconfined:{status:'denied'},
    apparmorEnabled:{status:'unrecognized'},apparmorConfinement:{status:'observed',value:'enforce'},
  });
  assert.equal(JSON.stringify(state).includes('private'),false);
});
test('fixture preflight requires explicit disposable-runner admission before output mutation',async t=>{
  const root=await temporary(t),output=path.join(root,'must-not-exist');
  await assert.rejects(preflightFixture({output}),/ephemeral/);
  await assert.rejects(fs.lstat(output),{code:'ENOENT'});
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
