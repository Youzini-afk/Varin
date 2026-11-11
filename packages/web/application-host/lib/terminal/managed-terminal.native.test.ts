import { looksLikeCanonicalWorkspaceId } from '../documents/workspace-registry.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {remoteExternalReviewTarget} from '../kernel/remote-external-review.test-helper.js';
import {createDocumentAuthority} from '../documents/authority.js';
import {createAuthorityTestRuntime} from '../kernel/authority.test-helper.js';
it('executes an action in the original remote PTY, reconnects its retained frames and confirms its stop',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-terminal-owner-'));
  const target=await remoteExternalReviewTarget(root);
  const documents=createDocumentAuthority({hostId:'child-review-host',dataDir:path.join(root,'coordinator-documents'),isAllowedRoot:async()=>true,isTrusted:async()=>true});
  const coordinator=await createAuthorityTestRuntime({hostId:'child-review-host',dataDir:path.join(root,'coordinator-native'),documents});
  try{
    const registry=target.registry(coordinator.client),owner=(await registry.sourceTargets()).targets[0]!.resourceOwner;
    const client=await registry.source(owner),base={coordinatorHostId:'child-review-host',sessionId:'original-remote-project-action'};
    const created=await client.terminal({...base,command:{action:'create',options:{cwd:target.directory,shell:process.platform==='win32'?'cmd':'sh'}}});
    expect(created.status).toBe('running');
    const frames:Record<string,unknown>[]=[];const controller=new AbortController();
    const stream=client.terminalStream(base,frame=>{frames.push(frame);},controller.signal).catch(error=>{if(!controller.signal.aborted)throw error;});
    await expect.poll(()=>frames[0]?.t).toBe('snapshot');
    const program=`require('node:fs').appendFileSync('action-result.txt','only-target\\n');process.stdout.write('TARGET_TERMINAL_MARKER\\n')`;
    await client.terminal({...base,command:{action:'write',inputId:'original-command',data:`"${process.execPath}" -e "${program}"\r`}});
    await expect.poll(async()=>fs.readFile(path.join(target.directory,'action-result.txt'),'utf8').catch(()=>null)).toBe('only-target\n');
    await expect.poll(()=>frames.some(frame=>String(frame.d??'').includes('TARGET_TERMINAL_MARKER'))).toBe(true);
    await client.terminal({...base,command:{action:'write',inputId:'original-command',data:`"${process.execPath}" -e "${program}"\r`}});
    await client.terminal({...base,command:{action:'write',inputId:'barrier-command',data:`"${process.execPath}" -e "require('node:fs').writeFileSync('barrier.txt','confirmed')"\r`}});
    await expect.poll(async()=>fs.readFile(path.join(target.directory,'barrier.txt'),'utf8').catch(()=>null)).toBe('confirmed');
    expect(await fs.readFile(path.join(target.directory,'action-result.txt'),'utf8')).toBe('only-target\n');
    controller.abort();await stream;
    const replay:Record<string,unknown>[]=[];const reconnection=new AbortController();
    const rewatch=client.terminalStream(base,frame=>{replay.push(frame);},reconnection.signal).catch(error=>{if(!reconnection.signal.aborted)throw error;});
    await expect.poll(()=>String(replay[0]?.history??'')).toContain('TARGET_TERMINAL_MARKER');
    expect((await client.terminal({...base,command:{action:'inspect'}})).sessionId).toBe(created.sessionId);
    await client.terminal({...base,command:{action:'resize',cols:100,rows:35}});
    const stopped=await client.terminal({...base,command:{action:'stop',force:true}});expect(stopped.status).toBe('exited');
    reconnection.abort();await rewatch;
    expect((await client.terminal({...base,command:{action:'close'}})).status).toBe('exited');
    expect((await client.terminal({...base,command:{action:'close'}})).status).toBe('exited');
    // More than the original 20 active-session limit, all real target PTYs.
    // Closing must release capacity while retaining the original stop receipt.
    for(let index=0;index<21;index++){
      const action={...base,sessionId:`sequential-action-${index}`};
      expect((await client.terminal({...action,command:{action:'create',options:{cwd:target.directory,shell:process.platform==='win32'?'cmd':'sh'}}})).status).toBe('running');
      expect((await client.terminal({...action,command:{action:'close',force:true}})).status).toBe('exited');
      expect((await client.terminal({...action,command:{action:'close',force:true}})).status).toBe('exited');
    }
    expect(await fs.stat(path.join(root,'action-result.txt')).catch(()=>null)).toBeNull();
  }finally{await coordinator.dispose();await documents.dispose();await target.close();await fs.rm(root,{recursive:true,force:true});}
},45_000);

it('runs an adopted project action in its frozen native view and never writes its physical baseline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-adopted-terminal-'));
  const target = await remoteExternalReviewTarget(root);
  const documents = createDocumentAuthority({ hostId: 'child-review-host', dataDir: path.join(root, 'coordinator-documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const coordinator = await createAuthorityTestRuntime({ documents, hostId: 'child-review-host', dataDir: path.join(root, 'coordinator-data') });
  let client: import('../harness/managed-remote-client.js').ManagedSourceClient | undefined;
  const base = { coordinatorHostId: 'child-review-host', sessionId: 'adopted-project-action' };
  try {
    const { createManagedProjectManagementOwner } = await import('../projects/managed-project-management.js');
    await fs.writeFile(path.join(target.directory, 'baseline.txt'), 'original project');
    const registered = await target.documents.resolveWorkspace({ path: target.directory });
    const management = createManagedProjectManagementOwner({ kernel: target.kernel, documents: target.documents, nativeWorkspaces: target.nativeWorkspaces });
    const principal = { principalId: 'paired-parent', capabilities: ['filesystem:read','filesystem:write','terminal:use','process:control'] };
    const project = { coordinatorHostId: base.coordinatorHostId, projectId: 'terminal-project', workspaceId: registered.workspaceId };
    const planned = await management(principal, { ...project, command: { action: 'workspace-plan', input: {} } }) as import('@varin/application-client').VersionedProjectWorkspace;
    expect(looksLikeCanonicalWorkspaceId(planned.executionWorkspaceId)).toBe(true);
    const backend = await management(principal, { ...project, command: { action: 'backend', input: {} } }) as import('@varin/application-client').WorkspaceBackendStatus;
    const registry = target.registry(coordinator.client), owner = (await registry.sourceTargets()).targets[0]!.resourceOwner;
    client = await registry.source(owner);
    const { state: _state, ...reference } = planned;
    const selection = { ...reference, mode: 'native_workspace' as const };
    const create = { ...base, command: { action: 'create' as const, options: { cwd: target.directory, selection, shell: process.platform === 'win32' ? 'cmd' as const : 'sh' as const } } };
    if (!backend.dependenciesReady) {
      await expect(management(principal, { ...project, workspace: planned, command: { action: 'enable', input: {} } })).rejects.toThrow();
      await expect(client.terminal(create)).rejects.toThrow();
      console.warn('Adopted terminal backend unavailable on target:', backend.backend, backend.detail);
      return;
    }
    await management(principal, { ...project, workspace: planned, command: { action: 'enable', input: {} } });
    const created = await client.terminal(create);
    expect(normalizePathIdentity(await canonicalizePathIdentity(created.cwd))).not.toBe(normalizePathIdentity((await target.documents.admitWorkspaceRegistration(registered.workspaceId)).canonicalPath));
    const data = `"${process.execPath}" -e "require('node:fs').writeFileSync('adopted-action.txt','only-adopted-view')"\r`;
    await client.terminal({ ...base, command: { action: 'write', inputId: 'original-write', data } });
    await expect.poll(async () => fs.readFile(path.join(created.cwd, 'adopted-action.txt'), 'utf8').catch(() => null)).toBe('only-adopted-view');
    expect(await fs.stat(path.join(target.directory, 'adopted-action.txt')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(target.directory, 'baseline.txt'), 'utf8')).toBe('original project');
    await expect(client.terminal({ ...base, command: { action: 'create', options: { cwd: target.directory, selection: { ...selection, branchId: 'different-branch' } } } })).rejects.toThrow();
    expect((await client.terminal({ ...base, command: { action: 'inspect' } })).cwd).toBe(created.cwd);
    const frames: Record<string, unknown>[] = [], controller = new AbortController();
    const stream = client.terminalStream(base, frame => { frames.push(frame); }, controller.signal).catch(error => { if (!controller.signal.aborted) throw error; });
    await expect.poll(() => frames[0]?.t).toBe('snapshot'); controller.abort(); await stream;
    expect((await client.terminal({ ...base, command: { action: 'close', force: true } })).status).toBe('exited');
  } finally {
    if (client) await client.terminal({ ...base, command: { action: 'close', force: true } }).catch(() => undefined);
    await coordinator.dispose(); await documents.dispose(); await target.close(); await fs.rm(root, { recursive: true, force: true });
  }
}, 45_000);
