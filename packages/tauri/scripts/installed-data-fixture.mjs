/** Synthetic installed-product data, written and reopened only by the existing
 * bundled Host/Rust/settings/credential owners. Never reads an OS user profile. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyRuntimeManifest,sha256} from './runtime-manifest.mjs';
import {writeResponsesStream,boundedBody} from './benchmark-fixture-service.mjs';
import {awaitRun} from './benchmark-seed.mjs';

export const applicationFixtureFile='application-data-fixture.json';
const product='varin-installed-application-data';
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
export const fixtureValues=nonce=>({projectId:`installer_${nonce.replaceAll('-','')}`,channelId:'installer-preservation',modelId:'installer-model',credentialReference:'installer-preservation',
  prompt:`Synthetic installer preservation input ${nonce}. Reply without tools.`,answer:`Synthetic installer preservation answer ${nonce}.`,secret:`fixture-only:${nonce}:host-model-auth`});

export async function admitApplicationFixtureSession(session,nonce,{seed=false}={}){
  if(!uuid(nonce)||!session||!path.isAbsolute(session.root??''))throw new Error('Application fixture requires its original nonce and private session');
  const temporary=await fs.realpath(os.tmpdir()),root=await fs.realpath(session.root);
  if(path.dirname(root)!==temporary||!path.basename(root).startsWith('varin-native-smoke-')||session.data!==path.join(session.root,'data')||session.home!==path.join(session.root,'home'))throw new Error('Application fixture must use its native-smoke temporary session');
  for(const directory of [session.root,session.data,session.home]){
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==(directory===session.root?root:path.join(root,path.basename(directory))))throw new Error('Application fixture session is redirected');
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
    const response=await fetch(new URL(route,url),{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(60_000)});
    if(!response.ok)throw new Error(`Application fixture API ${route} failed (${response.status})`);
    return response.json();
  };
}
export async function verifyApplicationFixtureApi(api,fixture){
  const [snapshot,settings,models,agent,run]=await Promise.all([api('/api/threads/snapshot',fixture.identity),api('/api/config/settings'),api('/api/models/read',{}),api('/api/models/settings/read',{}),api('/api/threads/run',{runId:fixture.runId})]);
  const channel=models.channels?.find(entry=>entry.id===fixture.channelId);
  if(snapshot.historyPage?.head!==fixture.head||hash(JSON.stringify(snapshot.history))!==fixture.historySha256||run.state!=='completed')throw new Error('Original completed chat history or Run receipt changed');
  if(!settings.projects?.some(entry=>entry.id===fixture.project.id&&entry.path===fixture.project.path&&entry.label===fixture.project.label)||settings.activeProjectId!==fixture.project.id||settings.fontSize!==113||settings.autoSaveEnabled!==false)throw new Error('Original project registration or Host settings changed');
  if(channel?.authentication?.kind!=='credential'||channel.authentication.reference!==fixture.credentialReference||agent.global?.defaultProvider!==fixture.channelId||agent.global?.defaultModel!==fixture.modelId)throw new Error('Original model configuration or credential binding changed');
  return{chatHistoryPreserved:true,completedRunPreserved:true,projectRegistrationPreserved:true,hostSettingsPreserved:true,modelCredentialBindingPreserved:true};
}

/** The helper uses the same bundled runtime as the candidate. A failed/unknown
 * owner stop never permits native launch, replacement, uninstall or cleanup. */
export async function runInstalledDataFixture(mode,candidate,session,nonce,{runtime=candidate.runtime,timeoutMs=240_000}={}){
  if(!['seed','verify'].includes(mode))throw new Error('Unsupported application fixture operation');
  await admitApplicationFixtureSession(session,nonce,{seed:mode==='seed'});
  if(mode==='verify')await readApplicationFixture(session,nonce,candidate);
  runtime=await fs.realpath(runtime);
  const manifest=await verifyRuntimeManifest(runtime,{platform:process.platform,architecture:process.arch});
  if(manifest.sources?.sourceSha!==candidate.sourceSha||manifest.version!==candidate.version)throw new Error('Application fixture runtime belongs to another candidate');
  const env={...process.env,VARIN_DATA_DIR:session.data,VARIN_KERNEL_PATH:path.join(runtime,manifest.kernel.executable),VARIN_RG_PATH:path.join(runtime,manifest.tools.ripgrep),VARIN_NODE_PATH:path.join(runtime,manifest.node.executable),
    VARIN_RESOURCES_PATH:runtime,VARIN_DIST_DIR:path.join(runtime,manifest.frontend.directory),VARIN_RUNTIME:'desktop',HOME:session.home,USERPROFILE:session.home,XDG_CONFIG_HOME:path.join(session.home,'.config'),APPDATA:path.join(session.home,'AppData/Roaming'),LOCALAPPDATA:path.join(session.home,'AppData/Local')};
  for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','VARIN_SERVER_URL','VARIN_SKIP_LOCAL_SERVER','VARIN_DATA_HOME','VARIN_ELECTRON_DEV','VARIN_ELECTRON_PROFILE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[key];
  const child=fork(fileURLToPath(import.meta.url),['--application-fixture-worker'],{execPath:path.join(runtime,manifest.node.executable),env,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  return new Promise((resolve,reject)=>{
    let result,done=false,failurePhase='process-observation';const fail=()=>{if(done)return;done=true;clearTimeout(timer);child.unref();child.channel?.unref();reject(Object.assign(new Error(`Application fixture failed at ${failurePhase}; owner completion is unconfirmed and private data retained`),{cleanupUncertain:true}));};
    const timer=setTimeout(fail,timeoutMs);
    child.once('error',fail);child.on('message',message=>{if(message?.ok===true)result=message.result;else{if(['admission','start-provider','start-host','load-owners','register-project','store-credentials','save-model','configure-agent','create-chat','complete-chat','verify-data','stop-owner','publish-marker'].includes(message?.phase))failurePhase=message.phase;fail();}});
    child.once('exit',(code,signal)=>{if(done)return;if(code!==0||signal||result?.ownerStopped!==true)return fail();done=true;clearTimeout(timer);resolve(result);});
    child.send({mode,runtime,session,nonce,candidate:{sourceSha:candidate.sourceSha,version:candidate.version}},error=>{if(error)fail();});
  });
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
    host=await startWebUiServer({port:0,host:'127.0.0.1',apiOnly:true,attachSignals:false,exitOnShutdown:false,desktopNetworkFetch:(url,init)=>{
      if(mode!=='seed'||new URL(url).origin!==provider)throw new Error('Installer fixture blocks external network');return fetch(url,init);
    }});
    const credentials=await host.getDesktopLocalCredentials(),api=applicationFixtureApi(`http://127.0.0.1:${host.getPort()}`,credentials.clientToken);
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
    return{mode,...observation,credentialValueAndIdentityPreserved:true,desktopInstallIdPreserved:true,desktopPreferencePreserved:true,projectFilePreserved:true,ownerStopped,provider:'controlled-loopback-only',valuesDisclosed:false};
  }catch(error){throw Object.assign(new Error('Synthetic application fixture failed'),{fixturePhase:phase});}finally{
    // Await the real owner, not a timeout kill or a sampled process table. No
    // marker is published if stop is uncertain; the caller retains all data.
    if(host)await host.stop({exitProcess:false});
    if(server){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }
}
if(process.argv.includes('--application-fixture-worker')){
  process.once('message',message=>{void worker(message).then(result=>process.send({ok:true,result},()=>process.disconnect()),error=>{process.exitCode=1;process.send?.({ok:false,phase:error.fixturePhase??'stop-owner'},()=>process.disconnect());});});
}
