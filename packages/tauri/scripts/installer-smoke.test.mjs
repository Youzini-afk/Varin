import {failRetainedObservation,seedOrVerify} from './installer-smoke.mjs';
import {createRequire} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
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
  const late=path.join(root,'original-owner-finished.txt');
  await assert.rejects(runObserved(process.execPath,['-e',`setTimeout(()=>require('fs').writeFileSync(process.argv[1],'original owner completed'),250)`,late],{timeoutMs:100}),error=>error.observed?.timedOut===true&&error.observed?.termination==='not-attempted-without-launch-bound-process-scope');
  await new Promise(resolve=>setTimeout(resolve,400));assert.equal(await fs.readFile(late,'utf8'),'original owner completed');
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
test('Windows admission refuses prior registrations and verifies owned per-user registration and shortcuts',async()=>{
  const clean={appData:'C:\\Users\\runner\\AppData\\Roaming',installations:[],uninstall:[],protocol:[],notifications:[],shortcuts:[]};
  assert.doesNotThrow(()=>assertCleanWindowsState(clean));
  for(const key of ['installations','uninstall','protocol','notifications','shortcuts'])assert.throws(()=>assertCleanWindowsState({...clean,[key]:[{}]}),/existing/);
  const directory='C:\\Temp\\Installed Varin',executable=path.win32.join(directory,'varin.exe');
  const installed={...clean,installations:[{hive:'HKCU',location:directory}],uninstall:[{hive:'HKCU',version:'1.0.0'}],notifications:[{hive:'HKCU'},{hive:'HKCU'}],protocol:[{hive:'HKCU',owner:executable,command:`"${executable}" "%1"`}],shortcuts:[{target:executable}]};
  const options={canonicalize:async file=>path.win32.resolve(file)};
  await assertInstalledWindowsState(installed,directory,'1.0.0',options);
  await assert.rejects(assertInstalledWindowsState({...installed,uninstall:[{...installed.uninstall[0],hive:'HKLM'}]},directory,'1.0.0',options),/per-user/);
  await assert.rejects(assertInstalledWindowsState({...installed,protocol:[{...installed.protocol[0],command:'other.exe "%1"'}]},directory,'1.0.0',options),/URL/);
  await assert.rejects(assertInstalledWindowsState({...installed,shortcuts:[{target:'C:\\Other\\varin.exe'}]},directory,'1.0.0',options),/shortcuts/);
});

test('native Windows shortcut comparison resolves real short-path aliases without accepting another file',{skip:process.platform!=='win32'},async t=>{
  const root=await temporary(t),directory=path.join(root,'Installed Varin Long Name');await fs.mkdir(directory);
  const executable=path.join(directory,'varin.exe');await fs.writeFile(executable,'synthetic executable bytes');
  const state={installations:[{hive:'HKCU',location:directory}],uninstall:[{hive:'HKCU',version:'1.0.0'}],notifications:[{hive:'HKCU'},{hive:'HKCU'}],protocol:[{hive:'HKCU',owner:executable,command:`"${executable}" "%1"`}],shortcuts:[{target:executable}]};
  await assertInstalledWindowsState(state,directory,'1.0.0');
  const other=path.join(root,'varin.exe');await fs.writeFile(other,'different executable');
  await assert.rejects(assertInstalledWindowsState({...state,shortcuts:[{target:other}]},directory,'1.0.0'),error=>error.shortcutObservation?.matching===0);
  const script=String.raw`Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class ShortPath{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetShortPathName(string path,StringBuilder result,uint size);}';$buffer=New-Object Text.StringBuilder 32768;$length=[ShortPath]::GetShortPathName($env:VARIN_SHORT_PATH_FIXTURE,$buffer,32768);if($length -eq 0){exit 2};$buffer.ToString()`;
  const alias=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,VARIN_SHORT_PATH_FIXTURE:executable},encoding:'utf8',windowsHide:true}).trim();
  if(alias.toLowerCase()===executable.toLowerCase()){t.diagnostic('8.3 aliases are disabled on this volume; exact/different native file checks passed.');return;}
  const result=await assertInstalledWindowsState({...state,shortcuts:[{target:alias}]},directory,'1.0.0');assert.equal(result.shortcutObservation.aliases,1);
});

test('failed installer evidence writing retains lifecycle uncertainty on the thrown result',async t=>{
  const root=await temporary(t),observation={failedStep:'fixture-stop',cleanupUncertain:true};
  await assert.rejects(failRetainedObservation(path.join(root,'observed.json'),observation,'Fixture stopped before completion.'),error=>error.cleanupUncertain===true&&error.reportWriteFailed===false);
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'observed.json'),'utf8')).cleanupUncertain,true);
  await fs.writeFile(path.join(root,'ordinary-file'),'not a directory');
  await assert.rejects(failRetainedObservation(path.join(root,'ordinary-file','report.json'),observation,'Fixture stopped before completion.'),error=>error.cleanupUncertain===true&&error.reportWriteFailed===true);
});

test('original Electron readback plus direct exit0 blocks a second profile reader without original-scope drain',{skip:process.platform!=='linux'},async t=>{
 const root=await temporary(t),executable=path.join(root,'fixture-reader'),nonce='synthetic-policy-test',profile=path.join(root,'profile'),output=path.join(root,'observation.json');
 const require=createRequire(new URL('../../electron/package.json',import.meta.url)),version=require('electron/package.json').version;
 // A finite reporter exercises the controller, not actual Electron behavior.
 const script=`#!${process.execPath}\nconst fs=require('fs'),path=require('path');const [, , , ,mode,root,nonce]=process.argv;fs.writeFileSync(path.join(root,'legacy-'+mode+'.json'),JSON.stringify({schema:1,product:'varin-legacy-profile-smoke',profileScope:'original-os-profile',mode,nonce,complete:true,frontendVerified:true,credentialSlotsVerified:6,browserCookieVerified:true,browserLocalStorageVerified:true,valuesDisclosed:false,electronVersion:${JSON.stringify(version)}}));\n`;
 await fs.writeFile(executable,script,{mode:0o755});let reopened=false;
 await assert.rejects((async()=>{await seedOrVerify('seed',{root},nonce,profile,output,executable);reopened=true;await seedOrVerify('verify',{root},nonce,profile,output,executable);})(),error=>error.cleanupUncertain===true&&/Chromium process scope/u.test(error.message));
 assert.equal(reopened,false);const evidence=JSON.parse(await fs.readFile(output,'utf8'));
 assert.equal(evidence.complete,true);assert.equal(evidence.directProcessObservation.code,0);assert.equal(evidence.cleanupUncertain,true);assert.equal(evidence.fullProcessScopeDrained,false);
 await assert.rejects(fs.stat(path.join(root,'legacy-verify.json')),{code:'ENOENT'});
});

test('direct original-profile verify rejects before deleting a prior receipt or starting another reader',async t=>{
 const root=await temporary(t),profile=path.join(root,'profile'),output=path.join(root,'output.json');
 const prior=JSON.stringify({complete:true,directProcessObservation:{code:0,signal:null},fullProcessScopeDrained:false});
 await fs.writeFile(path.join(root,'legacy-verify.json'),prior);
 await fs.writeFile(path.join(root,'legacy-seed.json'),prior);
 const before=(await fs.readdir(root)).sort();
 await assert.rejects(seedOrVerify('verify',{root},'same-fixture',profile,output,process.execPath),error=>error.cleanupUncertain===true&&/profile reopen requires confirmed full original process-scope/u.test(error.message));
 assert.deepEqual((await fs.readdir(root)).sort(),before);
 assert.equal(await fs.readFile(path.join(root,'legacy-verify.json'),'utf8'),prior);
 assert.equal(await fs.readFile(path.join(root,'legacy-seed.json'),'utf8'),prior);
});
