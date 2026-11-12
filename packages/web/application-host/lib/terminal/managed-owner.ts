/** A managed Host exposes its existing terminal owner, never a second PTY writer. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {parseProjectSourceSelection} from '@varin/application-client';
import {canonicalizePathIdentity, normalizePathIdentity, normalizeWorkspaceRelativePath} from '../workspace/path-safety.js';
import type {ManagedTerminalRequest,ManagedTerminalResult} from '@varin/application-client';
import type {ManagedSourcePrincipal} from '../harness/managed-remote-types.js';
import type {TerminalSessionApi, TerminalSessionInfo, TerminalWorkspaceSource} from './session-api.js';
import type {DocumentAuthority} from '../documents/authority.js';
import {assertResourcePathAllowed} from '../workspace/resource-access.js';
export function createManagedTerminalOwner(options:{terminal:()=>TerminalSessionApi|null;documents:DocumentAuthority;nativeWorkspaces?:Pick<import('../kernel/native-workspaces.js').NativeWorkspaceOwner,'prepareSelection'>}){
  const identity=(principal:ManagedSourcePrincipal,input:{coordinatorHostId:string;sessionId:string})=>{
    if(!principal.principalId||!input.coordinatorHostId||!input.sessionId||!principal.capabilities.includes('terminal:use')||!principal.capabilities.includes('process:control'))throw new Error('Terminal access is denied');
    return 'managed-terminal:'+createHash('sha256').update(JSON.stringify([principal.principalId,input.coordinatorHostId,input.sessionId])).digest('hex');
  };
  const permitted=async(principal:ManagedSourcePrincipal,cwd:string)=>{
    const resolved=await options.documents.resolveWorkspace({path:cwd});
    const workspace=await options.documents.inspectWorkspace(resolved.workspaceId);
    await assertResourcePathAllowed(workspace.root,principal.allowedDirectories);
    await options.documents.admitWorkspaceRegistration(resolved.workspaceId);
    return workspace.root;
  };
  const permittedSession=async(principal:ManagedSourcePrincipal,info:TerminalSessionInfo)=>{
    if(!info.source){await permitted(principal,info.cwd);return;}
    const original=await options.documents.admitWorkspaceRegistration(info.source.selection.workspaceId);
    if(normalizePathIdentity(original.canonicalPath)!==normalizePathIdentity(info.source.canonicalRoot))throw new Error('Original terminal physical source changed');
    await assertResourcePathAllowed(original.canonicalPath,principal.allowedDirectories);
    // Never re-prepare, follow a project's current binding or interpret its
    // mounted cwd as a new physical root when observing an accepted terminal.
  };
  const owner=()=>{const terminal=options.terminal();if(!terminal)throw new Error('Target terminal owner is unavailable');return terminal;};
  return {
    async command(principal:ManagedSourcePrincipal,input:ManagedTerminalRequest,signal?:AbortSignal):Promise<ManagedTerminalResult>{
      signal?.throwIfAborted();const id=identity(principal,input),terminal=owner(),command=input.command;
      if(!command||!['create','write','resize','appearance','stop','close','inspect'].includes(command.action))throw new Error('Invalid terminal operation');
      if(command.action==='create'){
        const value=command.options;
        if(!value||typeof value.cwd!=='string'||!value.cwd||value.resourceOwner!==undefined||value.workspacePath!==undefined)throw new Error('Target terminal requires its explicit directory');
        const requestedCwd=value.cwd;
        const selection=value.selection===undefined?undefined:parseProjectSourceSelection(value.selection);
        let cwd:string,source:TerminalWorkspaceSource|undefined;
        if(selection?.mode==='native_workspace'){
          const original=await options.documents.admitWorkspaceRegistration(selection.workspaceId,signal);
          await assertResourcePathAllowed(original.canonicalPath,principal.allowedDirectories);
          const selectedPath=selection.nativeScope?path.join(original.canonicalPath,normalizeWorkspaceRelativePath(selection.nativeScope)):original.canonicalPath;
          // Compare filesystem identities, including Windows short-name aliases,
          // without admitting a different root or widening the frozen scope.
          const [requestedIdentity,...allowedIdentities]=await Promise.all([requestedCwd,original.canonicalPath,selectedPath].map(async directory=>normalizePathIdentity(await canonicalizePathIdentity(directory))));
          if(!allowedIdentities.includes(requestedIdentity!))throw new Error('Terminal directory differs from its frozen project source');
          source={selection,canonicalRoot:original.canonicalPath};
          const existing=terminal.inspectSession(id);
          if(existing){
            if(!isDeepStrictEqual(existing.source,source))throw new Error('Terminal session belongs to another frozen source');
            await permittedSession(principal,existing);cwd=existing.cwd;
          }else{
            if(!options.nativeWorkspaces)throw new Error('Target native workspace owner is unavailable');
            cwd=(await options.nativeWorkspaces.prepareSelection(selection,id,signal)).path;
          }
        }else{
          if(terminal.inspectSession(id)?.source)throw new Error('Terminal session belongs to its original adopted source');
          cwd=await permitted(principal,requestedCwd);
        }
        // The target alone resolves shell, environment and integration scripts.
        await terminal.createTerminalSession({sessionId:id,cwd,retainWhenDetached:true,...(source?{source}:{}),
          ...(value.cols!==undefined?{cols:value.cols}:{}),...(value.rows!==undefined?{rows:value.rows}:{}),
          ...(value.shell!==undefined?{shell:value.shell}:{}),...(value.loginShell!==undefined?{loginShell:value.loginShell}:{}),
          ...(value.themeMode!==undefined?{themeMode:value.themeMode}:{}),
          ...(value.terminalBackground!==undefined?{terminalBackground:value.terminalBackground}:{}),
          ...(value.terminalForeground!==undefined?{terminalForeground:value.terminalForeground}:{})});
      }
      const info=terminal.inspectSession(id),handle=terminal.attachTerminalSession(id);
      if(!info||!handle)throw Object.assign(new Error('The original target terminal session is unavailable; it was not recreated'),{status:404});
      // Cleanup uses the original principal/session handle, not renewed file
      // admission: losing a directory must not make its process unstoppable.
      if(command.action!=='stop'&&command.action!=='close')await permittedSession(principal,info);
      if(command.action==='write'){
        if(typeof command.data!=='string'||typeof command.inputId!=='string'||!command.inputId)throw new Error('Terminal input requires its original identity');
        await handle.write(command.data,'terminal-input:'+createHash('sha256').update(JSON.stringify([id,command.inputId])).digest('hex'));
      }else if(command.action==='resize')await handle.resize(command.cols,command.rows);
      else if(command.action==='appearance'){
        if(!terminal.updateTerminalAppearance)throw new Error('Terminal appearance owner is unavailable');
        terminal.updateTerminalAppearance(id,command);
      }else if(command.action==='stop'||command.action==='close'){await handle.terminate(command.force===true);await handle.waitForExit();if(command.action==='close'){if(!terminal.retireTerminalSession)throw new Error('Terminal close owner is unavailable');await terminal.retireTerminalSession(id);}}
      const current=terminal.inspectSession(id)!;
      return {sessionId:input.sessionId,cwd:current.cwd,cols:current.cols??80,rows:current.rows??24,status:current.status};
    },
    async stream(principal:ManagedSourcePrincipal,input:{coordinatorHostId:string;sessionId:string},emit:(frame:Record<string,unknown>)=>void|Promise<void>,signal:AbortSignal):Promise<void>{
      signal.throwIfAborted();const id=identity(principal,input),terminal=owner(),info=terminal.inspectSession(id);
      if(!info||!terminal.observeTerminalSession)throw Object.assign(new Error('Original target terminal session is unavailable'),{status:404});
      await permittedSession(principal,info);
      if(!terminal.readTerminalSnapshot)throw new Error('Original terminal snapshot owner is unavailable');
      // One in-flight frame only. A slow network consumer rebases from the
      // owner's existing bounded v4 history, never a parallel unbounded queue.
      let sending=false,changed=false,flight:Promise<void>=Promise.resolve();
      let fail:(error:unknown)=>void=()=>{};
      const stopped=new Promise<void>((resolve,reject)=>{fail=reject;if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
      const subscription=terminal.observeTerminalSession(id,frame=>{
        if(signal.aborted)return;
        if(sending){changed=true;return;}
        sending=true;
        flight=(async()=>{try{let next:Record<string,unknown>|null=frame;
          while(next&&!signal.aborted){await emit(next);if(!changed)break;changed=false;next=terminal.readTerminalSnapshot!(id);if(!next)throw new Error('Original terminal disappeared');}
        }finally{sending=false;}})().catch(fail);
      });
      if(!subscription)throw new Error('Original terminal disappeared');
      try{await stopped;}finally{subscription.dispose();await flight;}

    },
  };
}
