/** Synthetic installed-product data, written and reopened only by the existing
 * bundled Host/Rust/settings/credential owners. Never reads an OS user profile. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyRuntimeManifest,sha256} from './runtime-manifest.mjs';
import {writeResponsesStream,boundedBody} from './benchmark-fixture-service.mjs';
import {awaitRun} from './benchmark-seed.mjs';
import {launchOwned,prepareNativeProcessOwner} from './native-process-owner.mjs';
import {claimSmokeSession,releaseSmokeSession} from './smoke-session.mjs';

export const applicationFixtureFile='application-data-fixture.json';
export const applicationFixtureOrigin='http://tauri.localhost';
const product='varin-installed-application-data';
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
export const fixtureValues=nonce=>({projectId:`installer_${nonce.replaceAll('-','')}`,channelId:'installer-preservation',modelId:'installer-model',credentialReference:'installer-preservation',
  prompt:`Synthetic installer preservation input ${nonce}. Reply without tools.`,answer:`Synthetic installer preservation answer ${nonce}.`,secret:`fixture-only:${nonce}:host-model-auth`});

const sessionSnapshot=session=>Object.freeze({root:session?.root,data:session?.data,home:session?.home});
export async function admitApplicationFixtureSession(session,nonce,{seed=false}={}){
  session=sessionSnapshot(session);
  if(!uuid(nonce)||!session||!path.isAbsolute(session.root??''))throw new Error('Application fixture requires its original nonce and private session');
  const temporary=await fs.realpath(os.tmpdir()),root=await fs.realpath(session.root);
  if(path.dirname(root)!==temporary||!path.basename(root).startsWith('varin-native-smoke-')||session.data!==path.join(session.root,'data')||session.home!==path.join(session.root,'home'))throw new Error('Application fixture must use its native-smoke temporary session');
  for(const directory of [session.root,session.data,session.home]){
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==(directory===session.root?root:path.join(root,path.basename(directory))))throw new Error('Application fixture session is redirected');
    if(directory===session.root&&process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw new Error('Application fixture requires its private original session');
  }
  if(seed&&(await fs.readdir(session.data)).length)throw new Error('Application fixture seed refuses existing data');
  return root;
}
export function validateApplicationFixture(value,{nonce,sourceSha,version}={}){
  const f=value,v=fixtureValues(nonce??'');
  if(!f||f.schema!==1||f.product!==product||f.nonce!==nonce||!uuid(nonce)||f.sourceSha!==sourceSha||!/^[a-f0-9]{40}$/u.test(sourceSha??'')||f.version!==version||f.complete!==true||f.ownerStopped!==true
    ||f.identity?.runtime!=='agent'||!/^thread:[a-f0-9]{64}$/u.test(f.identity.threadId??'')||!/^branch:[a-f0-9]{64}$/u.test(f.identity.branchId??'')
    ||typeof f.head!=='string'||!f.head||!/^[a-f0-9]{64}$/u.test(f.historySha256??'')||typeof f.runId!=='string'||!f.runId
    ||f.project?.id!==v.projectId||typeof f.project.path!=='string'||!f.project.path||f.project.label!=='Installer preservation fixture'
    ||f.channelId!==v.channelId||f.modelId!==v.modelId||f.credentialReference!==v.credentialReference||!uuid(f.credentialAccount)||f.credentialGeneration!==1||!uuid(f.installId))throw new Error('Application fixture receipt is incomplete or belongs to another invocation');
  // No secret or arbitrary payload is allowed in the control receipt.
  const keys=['schema','product','nonce','sourceSha','version','complete','ownerStopped','identity','head','historySha256','runId','project','channelId','modelId','credentialReference','credentialAccount','credentialGeneration','installId'];
  if(Object.keys(f).some(key=>!keys.includes(key))||Object.keys(f.identity).some(key=>!['runtime','threadId','branchId'].includes(key))||Object.keys(f.project).some(key=>!['id','path','label'].includes(key)))throw new Error('Application fixture receipt contains unsupported data');
  return f;
}
export async function readApplicationFixture(session,nonce,candidate){
  session=sessionSnapshot(session);candidate={sourceSha:candidate.sourceSha,version:candidate.version};
  const root=await admitApplicationFixtureSession(session,nonce),file=path.join(session.data,applicationFixtureFile),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('Application fixture receipt is not a bounded regular file');
  const fixture=validateApplicationFixture(JSON.parse(await fs.readFile(file,'utf8')),{nonce,sourceSha:candidate.sourceSha,version:candidate.version});
  // The registered workspace is ours, not a path from an arbitrary fixture file.
  const workspace=path.join(root,'workspace');
  if(path.resolve(fixture.project.path)!==workspace||await fs.realpath(workspace)!==workspace||(await fs.lstat(workspace)).isSymbolicLink())throw new Error('Application fixture project is outside its original session');
  return{fixture,sha256:await sha256(file)};
}
export function applicationFixtureApi(origin,token){
  const url=new URL(origin);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password||typeof token!=='string'||!token)throw new Error('Application fixture requires its authenticated loopback Host');
  return async(route,body,method=body===undefined?'GET':'POST')=>{
    if(!['/api/config/settings','/api/models/read','/api/models/save','/api/models/credentials/store','/api/models/settings/read','/api/models/settings/update','/api/threads/create','/api/threads/submit','/api/threads/run','/api/threads/snapshot'].includes(route))throw new Error('Unsupported application fixture route');
    const response=await fetch(new URL(route,url),{method,headers:{origin:applicationFixtureOrigin,authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(60_000)});
    if(!response.ok)throw new Error(`Application fixture API ${route} failed (${response.status})`);
    if(response.headers.get('access-control-allow-origin')!==applicationFixtureOrigin)throw new Error('Installed renderer origin is not admitted by the actual Host');
    return response.json();
  };
}
/** Node does not enforce browser CORS. Exercise the original Host's actual
 * preflight and authentication boundary rather than hide a packaged UI failure. */
export async function verifyApplicationFixtureBrowserBoundary(origin){
  const base=new URL(origin);
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.pathname!=='/'||base.search||base.hash||base.username||base.password)throw new Error('Browser boundary requires the original loopback Host');
  for(const method of ['GET','POST','PUT']){
    const response=await fetch(new URL('/api/config/settings',base),{method:'OPTIONS',headers:{origin:applicationFixtureOrigin,'access-control-request-method':method,'access-control-request-headers':'authorization,content-type'},redirect:'error',signal:AbortSignal.timeout(20_000)});
    const methods=(response.headers.get('access-control-allow-methods')??'').split(',').map(value=>value.trim());
    const headers=(response.headers.get('access-control-allow-headers')??'').toLowerCase().split(',').map(value=>value.trim());
    if(response.status!==204||response.headers.get('access-control-allow-origin')!==applicationFixtureOrigin||!methods.includes(method)||!headers.includes('authorization')||!headers.includes('content-type')||response.headers.has('set-cookie'))throw new Error('Actual Host browser preflight is missing or issues authentication');
    await response.arrayBuffer();
  }
  for(const [route,method] of [['/api/config/settings','GET'],['/auth/url-token','POST']]){
    const response=await fetch(new URL(route,base),{method,headers:{origin:applicationFixtureOrigin,cookie:'varin_ui_session=untrusted-fixture-cookie','content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(20_000)});
    await response.arrayBuffer();
    if(response.status!==401)throw new Error('Managed Host accepted an unauthenticated browser request');
  }
  const rejected=await fetch(new URL('/api/config/settings',base),{method:'OPTIONS',headers:{origin:'http://tauri.localhost.untrusted.invalid','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'},redirect:'error',signal:AbortSignal.timeout(20_000)});
  await rejected.arrayBuffer();
  if(rejected.headers.has('access-control-allow-origin'))throw new Error('Actual Host admitted an unrelated browser origin');
  return{packagedOriginPreflightVerified:true,anonymousHostAccessRejected:true,anonymousUrlTokenRejected:true,unrelatedOriginRejected:true};
}
export async function verifyApplicationFixtureApi(api,fixture){
  const [snapshot,settings,models,agent,run]=await Promise.all([api('/api/threads/snapshot',fixture.identity),api('/api/config/settings'),api('/api/models/read',{}),api('/api/models/settings/read',{}),api('/api/threads/run',{runId:fixture.runId})]);
  const channel=models.channels?.find(entry=>entry.id===fixture.channelId);
  if(snapshot.historyPage?.head!==fixture.head||hash(JSON.stringify(snapshot.history))!==fixture.historySha256||run.state!=='completed')throw new Error('Original completed chat history or Run receipt changed');
  if(!settings.projects?.some(entry=>entry.id===fixture.project.id&&entry.path===fixture.project.path&&entry.label===fixture.project.label)||settings.activeProjectId!==fixture.project.id||settings.fontSize!==113||settings.autoSaveEnabled!==false)throw new Error('Original project registration or Host settings changed');
  if(channel?.authentication?.kind!=='credential'||channel.authentication.reference!==fixture.credentialReference||agent.global?.defaultProvider!==fixture.channelId||agent.global?.defaultModel!==fixture.modelId)throw new Error('Original model configuration or credential binding changed');
  return{chatHistoryPreserved:true,completedRunPreserved:true,projectRegistrationPreserved:true,hostSettingsPreserved:true,modelCredentialBindingPreserved:true};
}

const controlProduct='varin-installed-application-fixture-control';
// Successful in-process generations, never JSON receipts, admit later reopens.
const applicationSessions=new WeakMap();
const resultKeys=['chatHistoryPreserved','completedRunPreserved','projectRegistrationPreserved','hostSettingsPreserved','modelCredentialBindingPreserved','packagedOriginPreflightVerified','anonymousHostAccessRejected','anonymousUrlTokenRejected','unrelatedOriginRejected','credentialValueAndIdentityPreserved','desktopInstallIdPreserved','desktopPreferencePreserved','projectFilePreserved','ownerStopped'];
const workerPhases=['admission','start-provider','start-host','verify-browser-boundary','load-owners','register-project','store-credentials','save-model','configure-agent','create-chat','complete-chat','verify-data','stop-owner','publish-marker'];
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const controlPaths=(root,launchId)=>{const directory=path.join(root,`.application-fixture-${launchId}`);return{directory,request:path.join(directory,'request.json'),result:path.join(directory,'result.json')};};
const scopeSummary=value=>value?{ownershipDrainConfirmed:value.ownershipDrainConfirmed===true,clean:value.clean===true,forced:value.forced===true,
  rootExit:value.rootExit?{code:value.rootExit.code,signal:value.rootExit.signal,success:value.rootExit.success===true}:null}:null;
function supportedOwnership(){
  if(!['linux','win32'].includes(process.platform))throw Object.assign(new Error('Application fixture not executed: full original descendant ownership is unsupported on this platform'),{execution:'not-executed',notExecuted:true,cleanupUncertain:true,processOwnership:null});
}
function validateRequest(request,{root,nonce,launchId}){
  if(!exactKeys(request,['schema','product','launchId','mode','runtime','session','nonce','candidate'])||request.schema!==1||request.product!==controlProduct||request.launchId!==launchId||request.nonce!==nonce||!uuid(nonce)||!uuid(launchId)
    ||!['seed','verify'].includes(request.mode)||!path.isAbsolute(request.runtime??'')||request.runtime.includes('\0')
    ||!exactKeys(request.session,['root','data','home'])||request.session.root!==root||request.session.data!==path.join(root,'data')||request.session.home!==path.join(root,'home')
    ||!exactKeys(request.candidate,['sourceSha','version'])||!/^[a-f0-9]{40}$/u.test(request.candidate.sourceSha??'')||typeof request.candidate.version!=='string'||!request.candidate.version||request.candidate.version.length>128)throw new Error('Application fixture private request admission failed');
  return request;
}
async function admitControlDirectory(root,launchId){
  if(!uuid(launchId))throw new Error('Application fixture launch identity is invalid');
  const files=controlPaths(root,launchId),stat=await fs.lstat(files.directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(files.directory)!==files.directory||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Application fixture private control directory is redirected or public');
  return files;
}
async function readControlFile(file){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16384||await fs.realpath(file)!==file||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Application fixture private control is not a bounded private regular file');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const current=await handle.stat();
    if(!current.isFile()||current.dev!==stat.dev||current.ino!==stat.ino||current.nlink!==1||current.size>16384||(process.platform!=='win32'&&(current.mode&0o077)!==0))throw new Error('Application fixture private control changed during admission');
    const bytes=Buffer.alloc(16385),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead>16384)throw new Error('Application fixture private control exceeded its bound');
    return JSON.parse(bytes.toString('utf8',0,bytesRead));
  }finally{await handle.close();}
}
function validateWorkerResult(value,request){
  if(!exactKeys(value,['schema','product','launchId','nonce','mode','ok',value?.ok===true?'result':'phase'])||value.schema!==1||value.product!==controlProduct||value.launchId!==request.launchId||value.nonce!==request.nonce||value.mode!==request.mode)throw new Error('Application fixture result belongs to another launch');
  if(value.ok!==true)throw Object.assign(new Error('Application fixture worker did not complete'),{fixturePhase:workerPhases.includes(value.phase)?value.phase:'process-observation'});
  const result=value.result;
  if(!exactKeys(result,['mode',...resultKeys,'provider','valuesDisclosed'])||result.mode!==request.mode||resultKeys.some(key=>result[key]!==true)||result.provider!=='controlled-loopback-only'||result.valuesDisclosed!==false)throw new Error('Application fixture semantic owner result is incomplete');
  return Object.fromEntries([...resultKeys.map(key=>[key,true]),['valuesDisclosed',false]]);
}

/** Process-boundary primitive. prepareLaunch and workerEntry are trusted tooling
 * dependencies, never inputs from a fixture file. Tests may use a trivial worker
 * here to prove real OS ownership; that is not bundled product/Host evidence. */
export async function runApplicationFixtureProcess({mode,candidate,session,nonce,runtime},{prepareLaunch,workerEntry=fileURLToPath(import.meta.url),timeoutMs=240_000,cleanupTimeoutMs=30_000,validateResult=async()=>{}}={}){
  const originalSession=session;session=sessionSnapshot(session);candidate=Object.freeze({sourceSha:candidate?.sourceSha,version:candidate?.version});
  supportedOwnership();
  if(!['seed','verify'].includes(mode)||typeof prepareLaunch!=='function'||!path.isAbsolute(workerEntry)||![timeoutMs,cleanupTimeoutMs].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=3_600_000))throw new Error('Invalid application fixture process request');
  const binding=JSON.stringify([session.root,session.data,session.home,nonce,candidate.sourceSha,candidate.version]);
  let generation=originalSession&&typeof originalSession==='object'?applicationSessions.get(originalSession):null;
  const mismatch=mode==='seed'?generation!==undefined&&generation!==null:!generation?.available||generation.binding!==binding||!/^[a-f0-9]{64}$/u.test(generation.markerSha256??'');
  if(mode==='verify'&&generation)generation.available=false;
  if(!originalSession||typeof originalSession!=='object'||mismatch)throw Object.assign(new Error('Application fixture not executed: original session generation is active or unconfirmed, or does not match'),{cleanupUncertain:true,execution:'not-executed',notExecuted:true,processOwnership:null});
  if(mode==='seed'){generation={binding,paths:session,available:false,markerSha256:null};applicationSessions.set(originalSession,generation);}
  // Consume the exact object's generation before the first asynchronous step.
  // Equivalent paths or copied JSON cannot manufacture a reopen capability.
  let root,lease;
  try{root=await admitApplicationFixtureSession(session,nonce);}catch{throw Object.assign(new Error('Application fixture not executed: private session admission failed'),{cleanupUncertain:true,execution:'not-executed',notExecuted:true,processOwnership:null});}
  try{lease=claimSmokeSession({root});}catch{throw Object.assign(new Error('Application fixture not executed: private session has an active or unconfirmed owner'),{cleanupUncertain:true,execution:'not-executed',notExecuted:true,processOwnership:null});}
  let owner,scopeResult,executed=false,phase='admission';
  try{
    await admitApplicationFixtureSession(session,nonce,{seed:mode==='seed'});
    if(mode==='verify'&&(await readApplicationFixture(session,nonce,candidate)).sha256!==generation.markerSha256)throw new Error('Application fixture marker changed after its original successful generation');
    const launchId=randomUUID(),request=validateRequest({schema:1,product:controlProduct,launchId,mode,runtime:await fs.realpath(runtime),session:{root,data:path.join(root,'data'),home:path.join(root,'home')},nonce,candidate:{sourceSha:candidate.sourceSha,version:candidate.version}},{root,nonce,launchId});
    phase='prepare-runtime';
    const launch=await prepareLaunch(request.runtime);
    const helperExecutable=await prepareNativeProcessOwner();
    const files=controlPaths(root,launchId);
    await fs.mkdir(files.directory,{mode:0o700});
    await fs.writeFile(files.request,JSON.stringify(request)+'\n',{flag:'wx',mode:0o600});
    await admitControlDirectory(root,launchId);
    phase='start-owner';executed=true;
    try{owner=await launchOwned({executable:launch.executable,args:[workerEntry,'--application-fixture-worker',root,nonce,launchId],cwd:root,env:launch.env,nonce:launchId},{helperExecutable});}
    catch(error){owner=error.owner;throw error;}
    phase='process-observation';
    scopeResult=await owner.settle({timeoutMs});
    // A late or forced stop is cleanup only. It cannot repair the failed attempt
    // or release its lease to a replacement/native/uninstall phase.
    if(!scopeResult.ownershipDrainConfirmed)throw new Error('Application fixture original process scope remained unconfirmed');
    phase='worker-result';
    await admitApplicationFixtureSession(session,nonce);
    await admitControlDirectory(root,launchId);
    const result=validateWorkerResult(await readControlFile(files.result),request);
    if(!scopeResult.clean||scopeResult.forced||scopeResult.rootExit?.success!==true)throw new Error('Application fixture native scope did not complete cleanly');
    const validated=await validateResult(request);
    if(mode==='verify'&&validated?.sha256!==generation.markerSha256)throw new Error('Application fixture marker changed during reopen');
    if(mode==='seed')generation.markerSha256=validated?.sha256??null;
    releaseSmokeSession(lease);
    generation.available=true;
    return{...result,processOwnership:scopeSummary(scopeResult)};
  }catch(error){
    if(owner&&scopeResult?.ownershipDrainConfirmed!==true){
      try{await owner.requestStop({forceAfterMs:1000});scopeResult=await owner.settle({timeoutMs:cleanupTimeoutMs});}catch{/* Preserve the original failed observation and its lease. */}
    }
    if(workerPhases.includes(error.fixturePhase))phase=error.fixturePhase;
    throw Object.assign(new Error(`Application fixture failed at ${phase}; private data retained and subsequent operations blocked`),{cleanupUncertain:true,execution:executed?'failed':'not-executed',notExecuted:!executed,processOwnership:scopeSummary(scopeResult)});
  }
}

/** The original Host.stop semantic receipt AND the original native full-scope
 * clean receipt are required. Neither app JSON nor root exit releases a session. */
export async function runInstalledDataFixture(mode,candidate,session,nonce,{runtime=candidate.runtime,timeoutMs=240_000}={}){
  const originalSession=session;session=sessionSnapshot(session);candidate=Object.freeze({sourceSha:candidate?.sourceSha,version:candidate?.version});
  return runApplicationFixtureProcess({mode,candidate,session:originalSession,nonce,runtime},{timeoutMs,prepareLaunch:async runtime=>{
    const manifest=await verifyRuntimeManifest(runtime,{platform:process.platform,architecture:process.arch});
    if(manifest.sources?.sourceSha!==candidate.sourceSha||manifest.version!==candidate.version)throw new Error('Application fixture runtime belongs to another candidate');
    const env={...process.env,VARIN_DATA_DIR:session.data,VARIN_KERNEL_PATH:path.join(runtime,manifest.kernel.executable),VARIN_RG_PATH:path.join(runtime,manifest.tools.ripgrep),VARIN_NODE_PATH:path.join(runtime,manifest.node.executable),
      VARIN_RESOURCES_PATH:runtime,VARIN_DIST_DIR:path.join(runtime,manifest.frontend.directory),VARIN_RUNTIME:'desktop',HOME:session.home,USERPROFILE:session.home,XDG_CONFIG_HOME:path.join(session.home,'.config'),APPDATA:path.join(session.home,'AppData/Roaming'),LOCALAPPDATA:path.join(session.home,'AppData/Local')};
    for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','VARIN_SERVER_URL','VARIN_SKIP_LOCAL_SERVER','VARIN_DATA_HOME','VARIN_ELECTRON_DEV','VARIN_ELECTRON_PROFILE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[key];
    return{executable:path.join(runtime,manifest.node.executable),env};
  },validateResult:()=>readApplicationFixture(session,nonce,candidate)});
}

async function worker({mode,runtime,session,nonce,candidate}){
  await admitApplicationFixtureSession(session,nonce,{seed:mode==='seed'});
  const values=fixtureValues(nonce),importHost=file=>import(pathToFileURL(path.join(runtime,'host/node_modules/@varin/web/server',file)).href);
  let fixture=mode==='verify'?(await readApplicationFixture(session,nonce,candidate)).fixture:null;
  let host,server,ownerStopped=false,phase='admission';
  try{
    phase='start-provider';
    server=http.createServer((request,response)=>{void(async()=>{
      if(mode!=='seed'||request.method!=='POST'||request.url!=='/v1/responses'||request.headers.authorization!==`Bearer ${values.secret}`){response.writeHead(403);response.end();return;}
      await boundedBody(request);await writeResponsesStream(response,{text:values.answer,delayMs:0,chunkBytes:4096});
    })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();});});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const provider=`http://127.0.0.1:${server.address().port}`;
    phase='start-host';
    const {startWebUiServer}=await importHost('index.js');
    host=await startWebUiServer({port:0,host:'127.0.0.1',apiOnly:true,requireClientAuth:true,attachSignals:false,exitOnShutdown:false,desktopNetworkFetch:(url,init)=>{
      if(mode!=='seed'||new URL(url).origin!==provider)throw new Error('Installer fixture blocks external network');return fetch(url,init);
    }});
    const credentials=await host.getDesktopLocalCredentials(),api=applicationFixtureApi(`http://127.0.0.1:${host.getPort()}`,credentials.clientToken);
    phase='verify-browser-boundary';
    const browserBoundary=await verifyApplicationFixtureBrowserBoundary(`http://127.0.0.1:${host.getPort()}`);
    phase='load-owners';
    const {createDesktopSettingsOwner}=await importHost('desktop-settings.js'),settingsOwner=createDesktopSettingsOwner();
    const {fileSecretStore}=await importHost('lib/models/credentials.js'),secrets=fileSecretStore(path.join(session.data,'model-auth.json'));
    if(mode==='seed'){
      phase='register-project';
      const workspace=path.join(await fs.realpath(session.root),'workspace');await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace,'preserved.txt'),'Synthetic original project file.\n',{flag:'wx'});
      await api('/api/config/settings',{projects:[{id:values.projectId,path:workspace,label:'Installer preservation fixture'}],activeProjectId:values.projectId,fontSize:113,autoSaveEnabled:false},'PUT');
      const config=await api('/api/config/settings');
      const project=config.projects?.find(entry=>entry.id===values.projectId);if(!project)throw new Error('Real Host did not register fixture project');
      await settingsOwner('setPreference',{key:'desktopMinimizeToTrayEnabled',enabled:false});
      const installId=await settingsOwner('desktop_install_id_get');
      phase='store-credentials';
      await api('/api/models/credentials/store',{secret:values.secret,reference:values.credentialReference});
      const models=await api('/api/models/read',{});
      phase='save-model';
      await api('/api/models/save',{expectedRevision:models.revision,channel:{id:values.channelId,name:'Installer synthetic preservation provider',type:'openai',enabled:true,baseUrl:`${provider}/v1`,authentication:{kind:'credential',reference:values.credentialReference},parameters:{},models:[{id:values.modelId,name:'Installer fixture',enabled:true,protocol:'openai-responses',operations:['chat'],input:['text'],contextWindow:1048576,maxOutputTokens:32768,reasoning:false}]}});
      phase='configure-agent';
      const agent=await api('/api/models/settings/read',{});
      await api('/api/models/settings/update',{scope:'global',expectedRevision:agent.globalRevision,set:{defaultProvider:values.channelId,defaultModel:values.modelId},remove:['defaultThinkingLevel']});
      phase='create-chat';
      const identity=await api('/api/threads/create',{key:`installer-preservation:${nonce}`}),before=await api('/api/threads/snapshot',identity);
      const accepted=await api('/api/threads/submit',{...identity,key:`installer-turn:${nonce}`,text:values.prompt,expectedHead:before.historyPage.head,model:{providerId:values.channelId,modelId:values.modelId}});
      phase='complete-chat';
      await awaitRun(api,accepted.run_id);
      const snapshot=await api('/api/threads/snapshot',identity),history=JSON.stringify(snapshot.history);
      if(!history.includes(values.prompt)||!history.includes(values.answer))throw new Error('Real completed chat did not retain both synthetic messages');
      const credential=JSON.parse(await secrets.read(values.credentialReference));
      fixture={schema:1,product,nonce,sourceSha:candidate.sourceSha,version:candidate.version,complete:true,ownerStopped:true,identity,head:snapshot.historyPage.head,historySha256:hash(history),runId:accepted.run_id,
        project:{id:project.id,path:project.path,label:project.label},channelId:values.channelId,modelId:values.modelId,credentialReference:values.credentialReference,credentialAccount:credential.account,credentialGeneration:credential.generation,installId};
    }
    phase='verify-data';
    validateApplicationFixture(fixture,{nonce,...candidate});
    const observation=await verifyApplicationFixtureApi(api,fixture);
    const credential=JSON.parse(await secrets.read(values.credentialReference)),settings=await settingsOwner('snapshot');
    if(credential?.value?.kind!=='api-key'||credential.value.key!==values.secret||credential.account!==fixture.credentialAccount||credential.generation!==fixture.credentialGeneration)throw new Error('Original synthetic credential value or account identity changed');
    if(settings.installId!==fixture.installId||settings.preferences.desktopMinimizeToTrayEnabled!==false)throw new Error('Original desktop install identity or preference changed');
    if(await fs.readFile(path.join(session.root,'workspace/preserved.txt'),'utf8')!=='Synthetic original project file.\n')throw new Error('Original project file changed');
    phase='stop-owner';
    await host.stop({exitProcess:false});host=null;ownerStopped=true;
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));server=null;
    phase='publish-marker';
    if(mode==='seed')await fs.writeFile(path.join(session.data,applicationFixtureFile),JSON.stringify(fixture)+'\n',{flag:'wx',mode:0o600});
    return{mode,...observation,...browserBoundary,credentialValueAndIdentityPreserved:true,desktopInstallIdPreserved:true,desktopPreferencePreserved:true,projectFilePreserved:true,ownerStopped,provider:'controlled-loopback-only',valuesDisclosed:false};
  }catch(error){throw Object.assign(new Error('Synthetic application fixture failed'),{fixturePhase:phase});}finally{
    // Await the real owner, not a timeout kill or a sampled process table. No
    // marker is published if stop is uncertain; the caller retains all data.
    if(host)await host.stop({exitProcess:false});
    if(server){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }
}
async function fixtureWorkerMain(){
  let request,files;
  try{
    supportedOwnership();
    const args=process.argv.slice(2);
    if(args.length!==4||args[0]!=='--application-fixture-worker')throw new Error('Invalid application fixture worker invocation');
    const [,root,nonce,launchId]=args;
    const session={root,data:path.join(root,'data'),home:path.join(root,'home')};
    if(await admitApplicationFixtureSession(session,nonce)!==root)throw new Error('Application fixture worker requires its exact original root');
    files=await admitControlDirectory(root,launchId);
    request=validateRequest(await readControlFile(files.request),{root,nonce,launchId});
    if(await fs.realpath(request.runtime)!==request.runtime)throw new Error('Application fixture runtime is redirected');
    const result=await worker(request);
    await fs.writeFile(files.result,JSON.stringify({schema:1,product:controlProduct,launchId,nonce,mode:request.mode,ok:true,result})+'\n',{flag:'wx',mode:0o600});
  }catch(error){
    process.exitCode=1;
    // No raw errors, paths, tokens, credentials or product records leave this
    // process. Even failure details use a fixed phase, on its private channel.
    if(request&&files){try{await fs.writeFile(files.result,JSON.stringify({schema:1,product:controlProduct,launchId:request.launchId,nonce:request.nonce,mode:request.mode,ok:false,phase:workerPhases.includes(error.fixturePhase)?error.fixturePhase:'admission'})+'\n',{flag:'wx',mode:0o600});}catch{}}
  }
}
if(process.argv.includes('--application-fixture-worker'))await fixtureWorkerMain();
