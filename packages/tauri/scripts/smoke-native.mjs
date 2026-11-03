/** Execute the actual native app in an isolated data/profile root. An exit code
 * or screenshot alone is not proof; require nonce-bound native case receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyProtocolRegistration, activateWarmProtocol} from './protocol-smoke.mjs';
import {sha256} from './runtime-manifest.mjs';
import {readApplicationFixture} from './installed-data-fixture.mjs';
export function validateNativeSmoke(report,{nonce,platform=process.platform,architecture=process.arch,requiredCases=[]}){
  if(report?.schema!==1||report.product!=='varin-desktop-native-smoke'||report.nonce!==nonce||report.platform!==platform
    ||report.architecture!==architecture||report.complete!==true||!Array.isArray(report.cases)||!report.cases.length)throw new Error('Native smoke receipt is missing, incomplete or belongs to another invocation');
  const names=new Set();for(const entry of report.cases){if(typeof entry.name!=='string'||names.has(entry.name)||entry.status!=='passed')throw new Error(`Native smoke case did not pass: ${entry.name??'unknown'}`);names.add(entry.name);}
  for(const name of requiredCases)if(!names.has(name))throw new Error(`Missing native smoke case: ${name}`);
  return report;
}
export async function createSmokeSession(){
  // Normalize the newly created directory through the OS, including Windows
  // 8.3 aliases and macOS /var links, before composing installer destinations.
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-')));
  const data=path.join(root,'data'),home=path.join(root,'home');
  await fs.mkdir(data);await fs.mkdir(home);return{root,data,home};
}
export async function smokeNative(candidate,{output,timeoutMs=180_000,protocolWarm=false,installedExecutable,installedInventory,disposableUser=false,session,legacyFixtureNonce,restart=false,useOsProfile=false,applicationData=false}={}){
  // An app-level native-drain report is not a launch-bound OS-scope receipt.
  // Deny before touching prior controls or allowing any second application.
  if(restart)throw Object.assign(new Error('Native smoke restart requires confirmed full original process-scope completion; private data retained'),{cleanupUncertain:true});
  if(useOsProfile&&!disposableUser)throw new Error('The original OS profile requires an explicit disposable OS user/session');
  if(legacyFixtureNonce&&(!/^[0-9a-f-]{36}$/u.test(legacyFixtureNonce)||!disposableUser||!useOsProfile))throw new Error('Synthetic legacy smoke requires its nonce and an explicit disposable OS profile');
  if(applicationData&&(!legacyFixtureNonce||!session))throw new Error('Application data smoke requires its original legacy fixture and session');
  if(protocolWarm) {
    if(!disposableUser)throw new Error('OS URL activation requires a disposable OS user/session; subprocess HOME isolation alone is insufficient');
    if(!installedExecutable)throw new Error('Warm protocol smoke requires an explicit installed executable');
    await verifyProtocolRegistration(installedExecutable);
  }
  if(installedExecutable){
    if(installedInventory){
      const entry=installedInventory.entries?.find(e=>e.path==='usr/share/Varin/varin');
      if(process.platform!=='linux'||installedExecutable!=='/usr/share/Varin/varin'||installedInventory.sourceSha!==candidate.sourceSha||installedInventory.artifactSha256!==candidate.packaged?.installed?.artifact?.sha256||entry?.type!=='file'||await sha256(installedExecutable)!==entry.sha256)throw new Error('Installed Debian executable differs from its candidate inventory');
    }else{
    const source=process.platform==='linux'?path.join(candidate.assets,candidate.packaged.update.name):path.join(candidate.payload,process.platform==='darwin'?'Contents/MacOS/varin':'varin.exe');
    if(await sha256(installedExecutable)!==await sha256(source))throw new Error('Installed executable differs from the candidate');
    }
  }
  const {root,data,home}=session??await createSmokeSession();
  const temporary=await fs.realpath(os.tmpdir()),resolved=await fs.realpath(root);
  if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('varin-native-smoke-')||data!==path.join(root,'data')||home!==path.join(root,'home'))throw new Error('Native smoke session is not its own temporary directory');
  for(const directory of [root,data,home])if(!(await fs.lstat(directory)).isDirectory()||await fs.realpath(directory)!==(directory===root?resolved:path.join(resolved,path.basename(directory))))throw new Error('Native smoke session contains a redirected directory');
  const applicationFixture=applicationData?await readApplicationFixture({root,data,home},legacyFixtureNonce,candidate):null;
  const nonce=randomUUID();
  await fs.writeFile(path.join(data,'smoke-request.json'),JSON.stringify({schema:1,nonce,...(protocolWarm?{protocolActivation:'warm'}:{}),...(legacyFixtureNonce?{legacyFixtureNonce,disposableOsUser:true}:{}),...(applicationFixture?{applicationFixtureSha256:applicationFixture.sha256}:{})})+'\n',{mode:0o600});
  const executable=installedExecutable??path.join(candidate.payload,process.platform==='darwin'?'Contents/MacOS/varin':process.platform==='win32'?'varin.exe':'varin');
  const env={...process.env,VARIN_DATA_DIR:data,VARIN_DESKTOP_RUNTIME_DIR:candidate.runtime,...(!useOsProfile?{HOME:home,USERPROFILE:home,
    APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config')}:{}),
    APPDIR:process.platform==='linux'?candidate.payload:'',VARIN_ELECTRON_DEV:'',VARIN_ELECTRON_PROFILE:''};
  // Every installed launch must discover its own packaged runtime. A source-tree
  // override would hide a broken installer even when URL activation is omitted.
  if(installedExecutable){delete env.VARIN_DESKTOP_RUNTIME_DIR;delete env.APPDIR;}
  delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,['--varin-desktop-smoke'],{cwd:installedExecutable?path.dirname(installedExecutable):candidate.payload,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:false});
  for(const stream of [child.stdout,child.stderr])stream.resume(); // Never surface renderer/Host output as test evidence.
  let timer,timedOut=false,evidence;
  const activationController=new AbortController();
  const activation=protocolWarm?activateWarmProtocol(data,nonce,{environment:process.env,signal:activationController.signal}).then(ready=>({ready}),error=>({error})):Promise.resolve({});
  try{
    const status=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
      timer=setTimeout(()=>{timedOut=true;
        // No launch-bound process guardian is available here. A numeric PID or
        // process group may have been reused; neither authorizes termination.
        child.unref();child.stdout?.unref?.();child.stderr?.unref?.();
        resolve({observationExpired:true,termination:'not-attempted-without-launch-bound-process-scope'});
      },timeoutMs);
    });
    activationController.abort();
    const activationResult=await activation;
    const report=await fs.readFile(path.join(data,'smoke-report.json'),'utf8').then(JSON.parse,error=>({missing:true,reason:error.code??'invalid-json'}));
    evidence={schema:1,target:candidate.target,sourceSha:candidate.sourceSha,version:candidate.version,
      runtimeManifestSha256:candidate.runtimeManifest.sha256,engineManifestSha256:candidate.engineManifest.sha256,status,timedOut,protocolActivation:protocolWarm?{isolation:'explicit-disposable-os-user',status:activationResult.error?'failed':'triggered',reason:activationResult.error?.message,ready:activationResult.ready}:null,report};
    if(timedOut||status.code!==0)throw new Error(`Native desktop smoke failed (${timedOut?'timeout':status.signal??status.code}); inspect its native receipt`);
    if(activationResult.error)throw activationResult.error;
    validateNativeSmoke(report,{nonce,requiredCases:['application-bridge','browser-same-page','browser-authority-isolation','browser-context-isolation','browser-capture','browser-pending-close','browser-download-terminal','osr-alpha-composition','network-stream-cancel','renderer-sandbox','native-drain',...(protocolWarm?['protocol-warm-activation']:[]),...(legacyFixtureNonce?['legacy-native-migration']:[]),...(applicationData?['application-data-preservation']:[])]});
    const drain=report.cases.find(entry=>entry.name==='native-drain')?.evidence;
    evidence.nativeOwnersDrained=drain?.browserOwnerDrained===true&&drain.applicationAndHostScopesEnded===true;
    evidence.fullProcessScopeDrained=false;
    if(protocolWarm)evidence.externalProtocolScopeDrained=false;
    // The native receipt is emitted before app.exit / CEF shutdown. Root exit
    // and original Browser/OSR/Host stop do not account for every OS descendant.
    // URL activation can also launch through an external broker outside this
    // child's eventual guardian. Keep its successful delivery as separate evidence.
    throw new Error('Native owner observations completed, but full original CEF process scope completion is unconfirmed; private data retained');
  }catch(error){
    // A shell exit or an expired observation is not proof that its detached native,
    // Host or migration owners relinquished these files. Keep the private root
    // on every unverified path, including spawn errors and malformed receipts.
    evidence??={schema:1,target:candidate.target,sourceSha:candidate.sourceSha,version:candidate.version,
      status:{spawnFailed:true,code:error.code??'UNKNOWN'},timedOut};
    evidence.cleanupUncertain=true;
    evidence.retainedPrivateDirectory=root;
    if(output){try{await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');}catch{evidence.reportWriteFailed=true;}}
    // Keep lifecycle uncertainty on the thrown result even if its evidence path
    // is unwritable; callers must never proceed to replacement or file cleanup.
    error.cleanupUncertain=true;error.nativeObservation=evidence;
    throw error;
  }finally{activationController.abort();clearTimeout(timer);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(!args[0]||!get('--output'))throw new Error('Usage: smoke-native.mjs candidate.json --output evidence.json [--protocol-warm --installed-executable FILE --disposable-os-user]');
  await smokeNative(JSON.parse(await fs.readFile(args[0],'utf8')),{output:get('--output'),protocolWarm:args.includes('--protocol-warm'),installedExecutable:get('--installed-executable'),disposableUser:args.includes('--disposable-os-user')});
}
