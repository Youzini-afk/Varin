import fsNative from 'node:fs';
import {createTerminalRuntime} from '../terminal/runtime.js';
import {createManagedTerminalOwner} from '../terminal/managed-owner.js';
/** Two original resource owners; only the external Harness bytes are controlled. */
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {registerCommonRequestMiddleware} from '../platform/core-routes.js';
import {createDocumentAuthority,type DocumentAuthority} from '../documents/authority.js';
import {createAuthorityTestRuntime} from './authority.test-helper.js';
import {createNativeWorkspaceOwner,type NativeWorkspaceOwner} from './native-workspaces.js';
import {createLiveSourceOwner} from './live-source.js';
import {createThreadSourcePreparer} from './thread-sources.js';
import {createThreadResourceScope,type ThreadResourceScopeOwners} from './thread-resource-scope.js';
import {createSourceQueryService} from './source-query-service.js';
import {createManagedCodeExchangeService} from './managed-code-exchange.js';
import {IntegrationCoordinator} from '../harness/working-state/integration-coordinator.js';
import {createManagedSourceService} from '../harness/managed-source-service.js';
import {createManagedRemoteTargetRegistry} from '../harness/managed-remote-client.js';
import {registerManagedRemoteRoutes} from '../harness/managed-remote-routes.js';
import {createManagedExternalChildSourceOwner} from '../external-agents/managed-child-source.js';
import {createManagedExternalProjectSourceOwner} from '../external-agents/managed-project-source.js';
import {createExternalSourceOwner} from '../external-agents/source.js';
import {ExternalAgentsService} from '../external-agents/service.js';
import {createKernelProcessService} from './process-service.js';
import type {KernelClient} from './kernel-client.js';
interface RemoteExternalReviewTarget {
  directory: string; documents: DocumentAuthority; kernel: KernelClient; nativeWorkspaces: NativeWorkspaceOwner; operations: string[]; script: string;
  registry(coordinator: KernelClient): ReturnType<typeof createManagedRemoteTargetRegistry>;
  close(): Promise<void>;
}
export async function remoteExternalReviewTarget(root:string): Promise<RemoteExternalReviewTarget> {
  const hostId='remote-external-review',directory=path.join(root,'target-work');await fs.mkdir(directory,{recursive:true});
  const workspaceOwner: { current?: NativeWorkspaceOwner } = {};
  const documents=createDocumentAuthority({hostId,dataDir:path.join(root,'target-documents'),isAllowedRoot:async()=>true,isTrusted:async()=>true,
    nativeWorkspaces:{resolveId:(id,signal,reference)=>workspaceOwner.current?.resolveId(id,signal,reference)??Promise.resolve(undefined),
      resolvePath:(value,containing)=>workspaceOwner.current?.resolvePath(value,containing)??Promise.resolve(undefined),
      retainReference:(source,key)=>workspaceOwner.current!.retainReference(source,key),releaseReference:key=>workspaceOwner.current!.releaseReference(key)}});
  const native=await createAuthorityTestRuntime({documents,hostId,dataDir:path.join(root,'target-data')});
  const kernel=native.client,storage=native.adapter,workingStates=native.workingStates;
  const nativeWorkspaces=createNativeWorkspaceOwner({kernel,documents,projects:async()=>[],update:async()=>{throw new Error('No target project mutation expected');}});
  workspaceOwner.current=nativeWorkspaces;
  kernel.nativeWorkspaces=nativeWorkspaces;
  const live=createLiveSourceOwner({kernel,documents});
  const resourceOwners:ThreadResourceScopeOwners={dataDirectory:path.join(root,'target-agent'),homeDir:path.join(root,'target-home'),workingStates,documents,
    validateLiveSource:live.validate,projectTrusted:async()=>true,configuration:async()=>({packages:[]}),
    withSourceRead:storage.withResourceRead.bind(storage),resolveNativeSource:async(source,signal)=>{
      const selected={workspace_id:source.workspaceId,execution_workspace_id:source.executionWorkspaceId,branch_id:source.branchId,...(source.nativeScope?{native_scope:source.nativeScope}:{})};
      const entry=await nativeWorkspaces!.open(selected,signal),view=await nativeWorkspaces!.acquire(selected,entry.grant,signal);
      return {hostId:view.hostId,rootId:view.rootId,canonicalRoot:view.path};}};
  const resources=createThreadResourceScope(resourceOwners);
  const capture={documents,prepareResources:resources.prepareSourceCapture,inspectInventory:async()=>({kind:'directory' as const})};
  const sourceOwner=createExternalSourceOwner({kernel,storage,capture});
  const query=createSourceQueryService({kernel,storage,documents,validateLiveSource:live.validate,resourceOwners});
  const exchange=createManagedCodeExchangeService({kernel,storage,documents,recovery:native.engine,metadataReader:native.recovery,
    coordinator:new IntegrationCoordinator({workingStates})});
  const processes=createKernelProcessService({client:kernel,resolveIdentity:async cwd=>{const found=await documents.resolveWorkspace({path:cwd});return{workspaceId:found.workspaceId,executionWorkspaceId:found.workspaceId,canonicalRoot:cwd};}});
  const external=new ExternalAgentsService({kernel,spawn:processes.spawn,spawnAdmitted:processes.spawnAdmitted,directory:path.join(root,'target-external'),
    resolveWorkspace:async cwd=>{const found=await documents.resolveWorkspace({path:cwd});return{workspaceId:found.workspaceId,root:(await documents.inspectWorkspace(found.workspaceId)).root};}});
  const script=path.join(root,'target-external.mjs');await fs.writeFile(script,`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';
if(process.argv.includes('--version')){console.log('target fixture');process.exit(0)}
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>send({jsonrpc:'2.0',id:m.id,result});
if(m.method==='initialize')reply({});if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:'target-real-session'}});if(m.method==='model/list')reply({data:[]});
if(m.method==='turn/start'){reply({turn:{id:'target-turn'}});writeFileSync('external-result.txt','Original target external bytes');send({method:'item/completed',params:{threadId:'target-real-session',turnId:'target-turn',item:{id:'target-answer',type:'agentMessage',text:'TARGET_EXTERNAL_RESULT'}}});send({method:'turn/completed',params:{threadId:'target-real-session',turn:{id:'target-turn',status:'completed'}}});}});`);
  const settings=await external.settings();await external.configure({defaultAgent:null,agents:[{id:'fixture',name:'External fixture',harness:'codex',enabled:true,command:process.execPath,args:[script]}]},settings.revision,'target-preset');
  const terminalOwner: { current?: ReturnType<typeof createTerminalRuntime> } = {};
  const operations:string[]=[];
  const source=createManagedSourceService({kernel,hostId,documents,terminal:createManagedTerminalOwner({terminal:()=>terminalOwner.current??null,documents,nativeWorkspaces}),validateLiveSource:live.validate,prepareExternalLiveSource:live.prepare,
    prepareSource:createThreadSourcePreparer({documents,workingStates,liveSources:live,nativeWorkspaces,inspectInventory:capture.inspectInventory,
      prepareResources:resources.prepareSourceCapture,sourceTools:mode=>kernel.agentRuntimeRequest('runtime.source.tools',{mode})}),
    externalSettings:signal=>external.settings(signal),externalLaunch:(id,harness,session,signal)=>external.managedLaunch(id,harness,session,signal),
    externalChildSource:createManagedExternalChildSourceOwner({kernel,hostId,sources:sourceOwner}),
    externalProjectSource:createManagedExternalProjectSourceOwner({kernel,storage,hostId}),
    serviceOperation:async(scope,operation,signal)=>{operations.push(operation.kind);
      return ['code_capture','code_apply','external_code_apply','code_release'].includes(operation.kind)?exchange(scope,operation,signal):query(scope,operation,signal);}});
  const app=express();registerCommonRequestMiddleware(app,{express});registerManagedRemoteRoutes(app,{service:{hostId,sources:()=>source,
    identity:async()=>({protocolVersion:1,hostId,capabilities:['sources'],machine:{machineId:'managed:'+hostId,kind:'managed-remote',state:'available'}})} as never,
    resolveAuthContext:async()=>({type:'client',clientId:'paired-parent',client:{capabilities:['filesystem:read','filesystem:write','terminal:use','process:control','logs:read']}} as never)});
  const server=await new Promise<import('node:http').Server>(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  terminalOwner.current=createTerminalRuntime({app,server,fs:fsNative,path,documents,loadPtyProvider:async()=>processes.ptyProvider,
    buildAugmentedPath:()=>process.env.PATH??'',searchPathFor:(name,paths)=>paths.split(path.delimiter).map(dir=>path.join(dir,name+(process.platform==='win32'?'.exe':''))).find(file=>fsNative.existsSync(file))??null,
    isExecutable:file=>{try{fsNative.accessSync(file,process.platform==='win32'?fsNative.constants.F_OK:fsNative.constants.X_OK);return true;}catch{return false;}},
    isRequestOriginAllowed:async()=>true,rejectWebSocketUpgrade:socket=>socket.destroy(),TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS:30_000});
  const endpoint=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return {directory,documents,kernel,nativeWorkspaces,operations,script,registry:(coordinator:KernelClient)=>createManagedRemoteTargetRegistry({coordinatorHostId:'child-review-host',kernel:coordinator,resources:{} as never,
    readSettings:async()=>({desktopHosts:[{id:'target-review',apiUrl:endpoint}]})}),
    async close(){await external.close();await terminalOwner.current?.shutdown();await processes.dispose();await query.dispose();await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});await native.dispose();await documents.dispose();}};
}
