import { expect, it, vi } from 'vitest';
import { createChildProjectSourcePreparer } from './child-project-source.js';
import type { ThreadPrepareSource, ThreadPreparedSource } from '@varin/application-client';
const backend={platform:'linux',architecture:'x64',reason:null,backend:'fuse' as const,dependenciesReady:true,mountCompiled:true,detail:null,helpUrl:'https://example.test/components'};

it('prepares only the chosen registered project through its actual source owner', async () => {
  const resolve=vi.fn(async () => ({resourceOwner:{kind:'local' as const},workspaceId:'actual-project',path:'D:/work/project/docs'}));
  const prepare=vi.fn(async (input:ThreadPrepareSource):Promise<ThreadPreparedSource> => ({path:'actual-execution-view',source:{resourceOwner:input.resourceOwner,
    workspaceId:input.workspaceId,executionWorkspaceId:'private-project',mode:'native_workspace',branchId:'project-baseline',tools:['file_read']}}));
  const owner=createChildProjectSourcePreparer({projects:async()=>[{id:'project',path:'D:/work/project'},{id:'other',path:'D:/work/other'}],inspectBackend:async()=>backend,sources:{resolve},prepare});
  const identity={runtime:'agent' as const,threadId:'thread:child',branchId:'branch:child'};
  const signal=new AbortController().signal;
  const result=await owner({id:'project',name:'Project',path:'D:/work/project',resource_owner:{kind:'local'}},identity,'original-operation','isolated_write','docs',signal);
  expect(resolve).toHaveBeenCalledExactlyOnceWith({resourceOwner:{kind:'local'},path:expect.stringMatching(/project[\\/]docs$/)},signal);
  expect(prepare).toHaveBeenCalledExactlyOnceWith({...identity,key:'original-operation',workspaceId:'actual-project',resourceOwner:{kind:'local'},mode:'materialized',content:{mode:'saved-files'},captureScopes:[]},signal);
  expect(result.source.executionWorkspaceId).toBe('private-project');
});

it('does not reopen a project that changed after this request was frozen', async () => {
  const resolve=vi.fn(),prepare=vi.fn();
  const owner=createChildProjectSourcePreparer({projects:async()=>[{id:'project',path:'D:/moved/project'}],inspectBackend:async()=>backend,sources:{resolve},prepare});
  await expect(owner({id:'project',name:'Project',path:'D:/old/project',resource_owner:{kind:'local'}},
    {runtime:'agent',threadId:'thread:child',branchId:'branch:child'},'original-operation','shared',null,new AbortController().signal)).rejects.toMatchObject({code:'project_source_changed'});
  expect(resolve).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it('reports an unavailable isolation backend before source resolution or directory capture',async()=>{
  const resolve=vi.fn(),prepare=vi.fn();
  const owner=createChildProjectSourcePreparer({projects:async()=>[{id:'project',path:'D:/work/project'}],sources:{resolve},prepare,
    inspectBackend:async()=>({...backend,dependenciesReady:false,reason:'missing_component'})});
  await expect(owner({id:'project',name:'Project',path:'D:/work/project',resource_owner:{kind:'local'}},
    {runtime:'agent',threadId:'thread:child',branchId:'branch:child'},'original-operation','isolated_write',null,new AbortController().signal)).rejects.toMatchObject({code:'workspace_backend_unavailable'});
  expect(resolve).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
});
