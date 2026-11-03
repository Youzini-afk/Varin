/** Execute the actual native app in an isolated data/profile root. An exit code
 * or screenshot alone is not proof; require nonce-bound native case receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyProtocolRegistration, activateWarmProtocol} from './protocol-smoke.mjs';
import {sha256} from './runtime-manifest.mjs';
export function validateNativeSmoke(report,{nonce,platform=process.platform,architecture=process.arch,requiredCases=[]}){
  if(report?.schema!==1||report.product!=='varin-desktop-native-smoke'||report.nonce!==nonce||report.platform!==platform
    ||report.architecture!==architecture||report.complete!==true||!Array.isArray(report.cases)||!report.cases.length)throw new Error('Native smoke receipt is missing, incomplete or belongs to another invocation');
  const names=new Set();for(const entry of report.cases){if(typeof entry.name!=='string'||names.has(entry.name)||entry.status!=='passed')throw new Error(`Native smoke case did not pass: ${entry.name??'unknown'}`);names.add(entry.name);}
  for(const name of requiredCases)if(!names.has(name))throw new Error(`Missing native smoke case: ${name}`);
  return report;
}
export async function smokeNative(candidate,{output,timeoutMs=180_000,protocolWarm=false,installedExecutable,disposableUser=false}={}){
  if(protocolWarm) {
    if(!disposableUser)throw new Error('OS URL activation requires a disposable OS user/session; subprocess HOME isolation alone is insufficient');
    if(!installedExecutable)throw new Error('Warm protocol smoke requires an explicit installed executable');
    const source=process.platform==='linux'?path.join(candidate.assets,candidate.packaged.update.name):path.join(candidate.payload,process.platform==='darwin'?'Contents/MacOS/varin':'varin.exe');
    if(await sha256(installedExecutable)!==await sha256(source))throw new Error('Installed executable differs from the candidate');
    await verifyProtocolRegistration(installedExecutable);
  }
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-'));const data=path.join(root,'data'),home=path.join(root,'home');
  await fs.mkdir(data);await fs.mkdir(home);const nonce=randomUUID();
  await fs.writeFile(path.join(data,'smoke-request.json'),JSON.stringify({schema:1,nonce,...(protocolWarm?{protocolActivation:'warm'}:{})})+'\n',{mode:0o600});
  const executable=installedExecutable??path.join(candidate.payload,process.platform==='darwin'?'Contents/MacOS/varin':process.platform==='win32'?'varin.exe':'varin');
  const env={...process.env,VARIN_DATA_DIR:data,VARIN_DESKTOP_RUNTIME_DIR:candidate.runtime,HOME:home,USERPROFILE:home,
    APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config'),
    APPDIR:process.platform==='linux'?candidate.payload:'',VARIN_ELECTRON_DEV:'',VARIN_ELECTRON_PROFILE:''};
  if(protocolWarm){delete env.VARIN_DESKTOP_RUNTIME_DIR;delete env.APPDIR;}
  delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,['--varin-desktop-smoke'],{cwd:candidate.payload,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:false});
  for(const stream of [child.stdout,child.stderr])stream.resume(); // Never surface renderer/Host output as test evidence.
  let timer,timedOut=false,verified=false,evidence;
  const activationController=new AbortController();
  const activation=protocolWarm?activateWarmProtocol(data,nonce,{environment:process.env,signal:activationController.signal}).then(ready=>({ready}),error=>({error})):Promise.resolve({});
  try{
    const status=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
      timer=setTimeout(()=>{timedOut=true;
        // This is a bounded private CI process tree, not the product's updater
        // drain. A forced timeout is always a failed observation, never success.
        if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{child.kill();}}
        else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
      },timeoutMs);
    });
    activationController.abort();
    const activationResult=await activation;
    const report=await fs.readFile(path.join(data,'smoke-report.json'),'utf8').then(JSON.parse,error=>({missing:true,reason:error.code??'invalid-json'}));
    evidence={schema:1,target:candidate.target,sourceSha:candidate.sourceSha,version:candidate.version,
      runtimeManifestSha256:candidate.runtimeManifest.sha256,engineManifestSha256:candidate.engineManifest.sha256,status,timedOut,protocolActivation:protocolWarm?{isolation:'explicit-disposable-os-user',status:activationResult.error?'failed':'triggered',reason:activationResult.error?.message,ready:activationResult.ready}:null,report};
    if(timedOut||status.code!==0)throw new Error(`Native desktop smoke failed (${timedOut?'timeout':status.signal??status.code}); inspect its native receipt`);
    if(activationResult.error)throw activationResult.error;
    validateNativeSmoke(report,{nonce,requiredCases:['application-bridge','browser-same-page','browser-authority-isolation','browser-context-isolation','browser-capture','browser-pending-close','browser-download-terminal','osr-alpha-composition','network-stream-cancel','renderer-sandbox','native-drain',...(protocolWarm?['protocol-warm-activation']:[])]});
    verified=true;
    evidence.cleanupUncertain=false;
    if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');}
    return evidence;
  }catch(error){
    // A shell exit or a timeout kill is not proof that its detached native,
    // Host or migration owners relinquished these files. Keep the private root
    // on every unverified path, including spawn errors and malformed receipts.
    evidence??={schema:1,target:candidate.target,sourceSha:candidate.sourceSha,version:candidate.version,
      status:{spawnFailed:true,code:error.code??'UNKNOWN'},timedOut};
    evidence.cleanupUncertain=!verified;
    if(!verified)evidence.retainedPrivateDirectory=root;
    if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');}
    throw error;
  }finally{activationController.abort();clearTimeout(timer);if(verified)await fs.rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(!args[0]||!get('--output'))throw new Error('Usage: smoke-native.mjs candidate.json --output evidence.json [--protocol-warm --installed-executable FILE --disposable-os-user]');
  await smokeNative(JSON.parse(await fs.readFile(args[0],'utf8')),{output:get('--output'),protocolWarm:args.includes('--protocol-warm'),installedExecutable:get('--installed-executable'),disposableUser:args.includes('--disposable-os-user')});
}
