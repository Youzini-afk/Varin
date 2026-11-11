import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import express from 'express';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createNativeProcessTestHarness} from '../process/native-process.test-helper.js';
import {createLiveSourceOwner} from '../kernel/live-source.js';
import {createManagedSourceService} from '../harness/managed-source-service.js';
import {registerManagedRemoteRoutes} from '../harness/managed-remote-routes.js';
import {createManagedRemoteTargetRegistry} from '../harness/managed-remote-client.js';
import {ExternalAgentsService} from './service.js';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
it('executes the original external Harness on the target Host, streams, resumes its native session and closes the original process',async()=>{
  const a=createNativeProcessTestHarness(undefined,{hostId:'coordinator'}),b=createNativeProcessTestHarness(undefined,{hostId:'target'});
  cleanups.push(()=>a.dispose(),()=>b.dispose());
  const coordinator=await a.get(),target=await b.get();
  const directory=path.join(target.root,'remote-project');await mkdir(directory);
  const script=path.join(target.root,'remote-program.mjs');
  await writeFile(script,`import{createInterface}from'node:readline';import{appendFileSync,readFileSync}from'node:fs';
if(process.argv.includes('--version')){console.log('remote fixture 1');process.exit(0)}
appendFileSync('executions',JSON.stringify({cwd:process.cwd(),program:process.argv[1]})+'\\n');
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');const reply=(id,result)=>send({jsonrpc:'2.0',id,result});let n=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')reply(m.id,{userAgent:'remote fixture'});
if(m.method==='model/list')reply(m.id,{data:[{id:'remote-model',model:'remote-model',displayName:'Remote'}]});
if(m.method==='thread/start'||m.method==='thread/resume'){appendFileSync('sessions',m.method+'\\n');reply(m.id,{thread:{id:'target-native-session'}})}
if(m.method==='turn/start'){if(m.params.input[0].text.startsWith('read:'))appendFileSync('delivered',readFileSync(m.params.input[0].text.slice(5)));const id='turn-'+(++n);reply(m.id,{turn:{id}});send({method:'turn/started',params:{threadId:'target-native-session',turn:{id}}});send({method:'item/agentMessage/delta',params:{threadId:'target-native-session',turnId:id,itemId:'answer'+n,delta:'REMOTE:'+m.params.input[0].text}});send({method:'turn/completed',params:{threadId:'target-native-session',turn:{id,status:'completed'}}})}
});`);
  const make=(native:typeof target,managed?:ConstructorParameters<typeof ExternalAgentsService>[0]['managed'])=>new ExternalAgentsService({kernel:native.client,spawn:native.service.spawn,
    directory:native.root,...(managed?{managed}:{}),resolveWorkspace:async cwd=>{const found=await native.documents.resolveWorkspace({path:cwd});return{workspaceId:found.workspaceId,root:(await native.documents.inspectWorkspace(found.workspaceId)).root};}});
  const targetService=make(target);cleanups.push(()=>targetService.close());
  const settings=await targetService.settings();await targetService.configure({defaultAgent:'remote-only',agents:[{id:'remote-only',name:'Target Fixture',harness:'codex',enabled:true,command:process.execPath,args:[script]}]},settings.revision,'target-config');
  const live=createLiveSourceOwner({kernel:target.client,documents:{getWorkspace:async id=>{const value=await target.documents.inspectWorkspace(id);return{root:value.root,hostId:'target'};},resolveWorkspace:input=>target.documents.resolveWorkspace(input)}});
  const sources=createManagedSourceService({kernel:target.client,hostId:'target',documents:target.documents,validateLiveSource:live.validate,prepareExternalLiveSource:live.prepare,
    prepareSource:async()=>{throw new Error('Native Thread preparation must not be used by external Harness');},externalSettings:signal=>targetService.settings(signal),
    externalLaunch:(id,harness,session,signal)=>targetService.managedLaunch(id,harness,session,signal)});
  const app=express();app.use(express.json());
  registerManagedRemoteRoutes(app,{service:{hostId:'target',sources:()=>sources,identity:async()=>({protocolVersion:1,hostId:'target',capabilities:['sources'],machine:{machineId:'managed:target',kind:'managed-remote',state:'available'}})} as never,
    resolveAuthContext:async()=>({type:'client',clientId:'paired-coordinator',client:{capabilities:['filesystem:read','filesystem:write','terminal:use','process:control','logs:read'],allowedDirectories:[directory]}} as never)});
  const server=await new Promise<import('node:http').Server>(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  cleanups.push(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const endpoint=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const registry=createManagedRemoteTargetRegistry({coordinatorHostId:'coordinator',kernel:coordinator.client,resources:{} as never,readSettings:async()=>({desktopHosts:[{id:'target-connection',apiUrl:endpoint}]})});
  const resourceOwner=(await registry.sourceTargets()).targets[0]!.resourceOwner;
  const service=make(coordinator,()=>({coordinatorHostId:'coordinator',source:registry.source}));cleanups.push(()=>service.close());
  expect((await service.settings(undefined,resourceOwner)).agents.some(a=>a.id==='remote-only')).toBe(true);
  expect((await service.settings()).agents.some(a=>a.id==='remote-only')).toBe(false);
  const conversation=await service.create({key:'remote',configurationId:'remote-only',source:{resourceOwner,path:directory}},'principal');
  const first=await service.send(conversation.id,'first',{text:'hello'});
  await vi.waitFor(async()=>expect((await service.read(conversation.id)).turns.find(t=>t.id===first.id)?.status).toBe('completed'),{timeout:15000});
  expect((await service.read(conversation.id)).conversation.sessionId).toBe('target-native-session');
  // Capture stays immutable on the target even after the mutable source changes.
  const remote=await registry.source(resourceOwner);
  const saved=await service.inspect(conversation.id) as typeof conversation & {transport:{id:string;authorityId:string;resourceEpoch:string}};
  const address={coordinatorHostId:'coordinator',authorityId:saved.transport.authorityId,resourceEpoch:saved.transport.resourceEpoch};
  await writeFile(path.join(directory,'original.txt'),'original remote bytes');
  const capture={...address,key:'capture-original',path:'original.txt'};
  const captured=await remote.externalCapture({...capture,action:'capture'}) as {contentHash:string;byteLength:number};
  await writeFile(path.join(directory,'original.txt'),'changed after capture');
  const page=await remote.externalCapture({...capture,action:'read',offset:0,length:captured.byteLength}) as {bytesBase64:string;hash:string};
  expect(Buffer.from(page.bytesBase64,'base64').toString()).toBe('original remote bytes');expect(page.hash).toBe(captured.contentHash);
  await remote.externalCapture({...capture,action:'release',committed:true});
  // Original Source import prepares an execution-host read-only file, which the
  // actual target Harness process reads. No coordinator cwd/path is supplied.
  const bytes=Buffer.from('delivered from coordinator');
  const attachment={ref:'attachment:delivered',filename:'delivered.txt',mimeType:'text/plain',byteLength:bytes.length};
  const contentHash=`sha256-${createHash('sha256').update(bytes).digest('hex')}`;
  const imported={...address,operationId:'attachment-delivery',attachment,contentHash};
  await remote.attachmentBegin(imported);
  await remote.attachmentPut({...address,operationId:imported.operationId,ref:attachment.ref,contentHash,objectHash:contentHash,byteLength:bytes.length},(async function*(){yield bytes;})());
  const view=await remote.attachmentPath(imported);expect(view.readOnly).toBe(true);
  // A recovery/maintenance caller cannot reclaim an immutable attachment merely
  // because it lives outside the still-running Harness cwd.
  const retentionGrant=await target.client.issueGrant({grantId:'external-view-retention-check',threadId:conversation.id,
    externalTransportId:saved.transport.id,operationId:saved.transport.id,
    owningWorkspace:conversation.executionSource!.workspace_id,executionWorkspace:conversation.executionSource!.execution_workspace_id,
    capabilities:['storage.read','storage.write','storage.maintenance'],pathScopes:[]});
  try { await expect(target.client.scoped(retentionGrant).objectViewRelease({workspaceId:conversation.executionSource!.workspace_id,viewId:view.viewId})).rejects.toThrow(/retained by its external process/); }
  finally { await target.client.retireGrant(retentionGrant.grantId); }

  const delivery=await service.send(conversation.id,'delivery',{text:`read:${view.path}`});
  await vi.waitFor(async()=>expect((await service.read(conversation.id)).turns.find(t=>t.id===delivery.id)?.status).toBe('completed'),{timeout:15000});
  expect(await readFile(path.join(directory,'delivered'),'utf8')).toBe(bytes.toString());
  await service.disconnect(conversation.id);
  await service.connect(conversation.id);
  const second=await service.send(conversation.id,'second',{text:'again'});
  await vi.waitFor(async()=>expect((await service.read(conversation.id)).turns.find(t=>t.id===second.id)?.status).toBe('completed'),{timeout:15000});
  const executionRoot=await realpath(directory);
  expect((await readFile(path.join(directory,'executions'),'utf8')).trim().split('\n').map(v=>JSON.parse(v))).toEqual([{cwd:executionRoot,program:script},{cwd:executionRoot,program:script}]);
  expect(await readFile(path.join(directory,'sessions'),'utf8')).toBe('thread/start\nthread/resume\n');
  const current=(await service.read(conversation.id)).conversation;await service.update(conversation.id,current.revision,{deleted:true},'delete');
  const stored=await service.inspect(conversation.id) as typeof conversation & {transport:{state:string}};expect(stored.transport.state).toBe('closed');
  expect((await targetService.list())).toEqual([]);
},60000);
