import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { createResourceFilesOwner } from './resource-files.js';

it('opens an independent workspace at its admitted physical view, not its original configuration directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-resource-view-'));
  const original = path.join(root, 'original'), mounted = path.join(root, 'mounted');
  await fs.mkdir(original); await fs.mkdir(mounted);
  await fs.writeFile(path.join(original, 'original.txt'), 'original');
  await fs.writeFile(path.join(mounted, 'isolated.txt'), 'isolated');
  const documents = {
    resolveWorkspace: async () => ({ workspaceId: 'independent', hostId: 'owner' }),
    admitWorkspaceRegistration: async () => ({ hostId: 'owner', canonicalPath: original }),
    inspectWorkspace: async () => ({ workspaceId: 'independent', hostId: 'owner', root: mounted }),
  } as unknown as DocumentAuthority;
  const files = createResourceFilesOwner(documents, {} as KernelFileResourceBackend);
  try {
    const opened = await files.request({ command: { kind: 'open', path: mounted } });
    expect(opened).toMatchObject({ kind: 'opened', root: mounted, workspaceId: 'independent' });
    const listed = await files.request({ root: mounted, workspaceId: 'independent', command: { kind: 'list', path: '' } });
    expect(listed.kind === 'list' && listed.page.entries.map(entry => entry.name)).toEqual(['isolated.txt']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('keeps native project selection logical while files and editor identities use the original target Documents view', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-adopted-files-'));
  const original = path.join(directory, 'physical'), mounted = path.join(directory, 'native');
  await fs.mkdir(original);await fs.mkdir(mounted);
  await fs.writeFile(path.join(original,'physical.txt'),'physical');await fs.writeFile(path.join(mounted,'adopted.txt'),'adopted');
  const selection={mode:'native_workspace' as const,workspaceId:'physical-registration',executionWorkspaceId:'adopted-documents',branchId:'adopted',adoptionOperationId:'original-adoption'};
  const documents={resolveWorkspace:async ({path:root}:{path:string})=>{expect(root).toBe(mounted);return {workspaceId:'adopted-documents'};},
    admitWorkspaceRegistration:async()=>({hostId:'target',canonicalPath:original}),inspectWorkspace:async()=>({root:mounted})} as unknown as DocumentAuthority;
  const files=createResourceFilesOwner(documents,{} as KernelFileResourceBackend,undefined,async selected=>{
    expect(selected).toEqual(selection);return {path:mounted,originalRoot:original};
  });
  try {
    const opened=await files.request({selection,command:{kind:'open',path:original}});
    expect(opened).toMatchObject({kind:'opened',root:original,workspaceId:'adopted-documents'});
    const listed=await files.request({selection,root:original,workspaceId:'adopted-documents',command:{kind:'list',path:''}});
    expect(listed.kind==='list' && listed.page.entries.map(entry=>entry.name)).toEqual(['adopted.txt']);
    const bytes=await files.request({selection,root:original,workspaceId:'adopted-documents',command:{kind:'bytes',path:'adopted.txt',offset:0}});
    expect(bytes.kind==='bytes' && Buffer.from(bytes.bytesBase64,'base64').toString()).toBe('adopted');
    await expect(files.request({selection,root:original,workspaceId:'physical-registration',command:{kind:'list',path:''}})).rejects.toThrow('location changed');
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});

it('searches the admitted native view with original compute adapters and preserves coverage and hit identity', async () => {
  const { createFsSearchRuntime } = await import('../fs/search.js');
  const { createWorkspaceContentSearch } = await import('../search/content.js');
  const { vi } = await import('vitest');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-search-view-'));
  const physical = path.join(directory, 'physical'), mounted = path.join(directory, 'native');
  await fs.mkdir(physical); await fs.mkdir(mounted); await fs.mkdir(path.join(mounted,'nested'));
  const selection = { mode: 'native_workspace' as const, workspaceId: 'physical', executionWorkspaceId: 'view', branchId: 'branch', adoptionOperationId: 'adoption' };
  const documents = {
    resolveWorkspace: async ({path: selected}: {path:string}) => { expect(selected).toBe(mounted); return {workspaceId:'view'}; },
    admitWorkspaceRegistration: async () => ({hostId:'target'}), inspectWorkspace: async () => ({root:mounted}),
    getWorkspace: async (id:string) => { expect(id).toBe('view'); return {root:mounted}; },
  };
  let partial = false;
  const compute: Pick<import('../kernel/compute-service.js').KernelComputeService,'directory'> = { directory: vi.fn<import('../kernel/compute-service.js').KernelComputeService['directory']>(async (root, request, options = {}) => {
    expect(root).toBe(mounted); expect(request.includeHidden).toBe(true); expect(request.respectGitignore).toBe(false);
    options.signal?.throwIfAborted();
    await options.onRecords?.(request.operation === 'list'
      ? [{kind:'entry',path:'nested/needle.ts',revision:'original-revision',data:{kind:'file'}}]
      : [{kind:'hit',path:'nested/needle.ts',revision:'original-revision',data:{line:2,column:3,preview:'needle',before:[],after:[]}}]);
    return {status: partial ? 'partial' : 'ready', scannedFiles: 1, records:[], kernelEpoch:'epoch', workspaceId:'view', jobId:'search', root:null, nextCursor:1, endCursor:1, message:null};
  }) };
  const owner = createResourceFilesOwner(documents as unknown as DocumentAuthority, {} as KernelFileResourceBackend,
    undefined, async selected => {expect(selected).toEqual(selection);return {path:mounted,originalRoot:physical};},
    {files:createFsSearchRuntime({compute}),content:createWorkspaceContentSearch({documents,compute})});
  const location = {root:physical,workspaceId:'view',selection};
  try {
    expect(await owner.request({...location,command:{kind:'filename-search',path:'',query:'needle',includeHidden:true,respectGitignore:false}})).toEqual({kind:'filename-search',results:[{path:'nested/needle.ts'}],enumerationStatus:'complete'});
    partial = true;
    expect(await owner.request({...location,command:{kind:'filename-search',path:'',query:'needle',includeHidden:true,respectGitignore:false}})).toMatchObject({enumerationStatus:'incomplete'});
    expect(await owner.request({...location,command:{kind:'content-search',path:'nested',query:'needle',includeHidden:true,respectGitignore:false}})).toMatchObject({kind:'content-search',result:{status:'ready',incomplete:true,hits:[{resource:{workspaceId:'view',resourceId:'nested/needle.ts'},revision:'original-revision',line:2,column:3}]}});
    await expect(owner.request({...location,command:{kind:'filename-search',path:'../physical',query:''}})).rejects.toThrow();
    await expect(owner.request({...location,workspaceId:'forged',command:{kind:'content-search',path:'',query:'needle'}})).rejects.toThrow('location changed');
    const controller = new AbortController();controller.abort();
    await expect(owner.request({...location,command:{kind:'filename-search',path:'',query:''}},controller.signal)).rejects.toThrow();
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
