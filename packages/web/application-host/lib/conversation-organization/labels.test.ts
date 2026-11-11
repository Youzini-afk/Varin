import { expect, it, vi } from 'vitest';
import { readConversationOrganizationLabels } from './labels.js';
it('reads each original owner once and preserves missing stable identities', async () => {
  const bots = vi.fn(async () => [{id:'bot',name:'Varin'}]); const settings = vi.fn(async () => ({projects:[{id:'project',label:'Research',path:'/research'}]}));
  expect(await readConversationOrganizationLabels({botIds:['bot','gone','bot'],projectIds:['project','gone']},{bots,settings},new AbortController().signal)).toEqual({
    bots:[{id:'bot',name:'Varin',status:'available'},{id:'gone',name:null,status:'missing'}], projects:[{id:'project',name:'Research',status:'available'},{id:'gone',name:null,status:'missing'}],
  }); expect(bots).toHaveBeenCalledTimes(1); expect(settings).toHaveBeenCalledTimes(1);
});
it('does not turn a failed or malformed project generation into missing names', async () => {
  const owners = {bots:async () => [],settings:async () => ({projects:[{id:'broken'}]})};
  expect((await readConversationOrganizationLabels({botIds:[],projectIds:['project']},owners,new AbortController().signal)).projects).toEqual([{id:'project',name:null,status:'unavailable'}]);
});

it('uses original project paths for absent or empty labels', async () => {
  const owners = { bots: async () => [], settings: async () => ({ projects: [{id:'empty',label:'',path:'/empty'}, {id:'absent',path:'/absent'}] }) };
  expect((await readConversationOrganizationLabels({botIds:[],projectIds:['empty','absent']}, owners, new AbortController().signal)).projects).toEqual([
    {id:'empty',name:'/empty',status:'available'}, {id:'absent',name:'/absent',status:'available'},
  ]);
});
