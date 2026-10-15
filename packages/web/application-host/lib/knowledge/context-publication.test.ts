import { expect, it, vi } from 'vitest';
import { createContextObservationPublication } from './context-publication.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ContextObservationSource, Run } from '../kernel/protocol.generated.js';
const owner: ContextObservationSource = { threadId:'thread',branchId:'branch',runId:'original',anchorId:'input',epoch:1,
  source:{resource_owner:{kind:'local'},mode:'live_root',live_root:{hostId:'host',rootId:'root',canonicalRoot:'/root'},workspace_id:'ws',execution_workspace_id:'ws',branch_id:null,revision:null} };
const run = {id:'next'} as Run;
it('publishes original same-source Run facts once per native receipt and retries after lost observations', async () => {
  const admitted: unknown[] = []; let fail = true;
  const request = vi.fn(async (method: string, params: {owner?: ContextObservationSource; events?: Array<{id:number}>}) => {
    if (method.endsWith('sources')) return [owner];
    admitted.push(params); if (fail) { fail=false; throw new Error('receipt observer disconnected'); }
    return params.events!.map(event => ({id:`observation:original:${event.id}`,cursor:8,state:'queued'}));
  });
  const publication=createContextObservationPublication({agentRuntimeRequest:request} as unknown as Pick<KernelClient,'agentRuntimeRequest'>);
  const context={drain:vi.fn(async()=>{}), observationsForSource:vi.fn(async (selected: ContextObservationSource, options: {afterEventId?:number} = {}) => ({owner:selected,eventCursor:2,events:options.afterEventId ? [] : [
    {ref:'observation:original:1',event:{id:1,kind:'edit' as const,at:1,text:'editor save',source:'user' as const,sessionId:'original'}},
    {ref:'observation:original:2',event:{id:2,kind:'edit' as const,at:2,text:'own tool write',source:'agent' as const,sessionId:'original'}},
  ]}))};
  await expect(publication.publish(context,run,new AbortController().signal)).rejects.toThrow('disconnected');
  await publication.publish(context,run,new AbortController().signal); await publication.publish(context,run,new AbortController().signal);
  expect(admitted).toHaveLength(2); expect(admitted[1]).toEqual({owner,events:[{id:1,kind:'edit',at:1,text:'editor save',source:'user'}]});
  expect(context.observationsForSource.mock.calls.map(([,options])=>options?.afterEventId)).toEqual([0,0,2]);
});
it('abandoning one preparation never acknowledges an unobserved publication', async () => {
  let resolve!: (value: unknown) => void; const admitted=new Promise(done=>{resolve=done;});
  const request=vi.fn(async (method:string)=>method.endsWith('sources')?[owner]:admitted);
  const publication=createContextObservationPublication({agentRuntimeRequest:request} as unknown as Pick<KernelClient,'agentRuntimeRequest'>);
  const context={drain:async()=>{},observationsForSource:vi.fn(async(_owner: ContextObservationSource, _options: {afterEventId?:number} = {})=>({owner,eventCursor:1,events:[{ref:'observation:original:1',event:{id:1,kind:'source' as const,at:1,text:'Git changed',source:'external' as const,sessionId:'original'}}]}))};
  const controller=new AbortController(); const work=publication.publish(context,run,controller.signal); const rejected=expect(work).rejects.toThrow();
  await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(2)); controller.abort(); resolve([{id:'observation:original:1',cursor:1,state:'queued'}]); await rejected;
  await publication.publish(context,run,new AbortController().signal); expect(context.observationsForSource.mock.calls[1]?.[1]).toMatchObject({afterEventId:0});
});

const materialFor = (selected: ContextObservationSource, ids: number[]) => ({
  owner: selected, eventCursor: ids.at(-1) ?? 0,
  events: ids.map(id => ({ ref: `observation:${selected.runId}:${id}`,
    event: { id, kind: 'edit' as const, at: id, text: 'editor save', source: 'user' as const, sessionId: selected.runId } })),
});
const receiptFor = (selected: ContextObservationSource, id: number) => ({ id: `observation:${selected.runId}:${id}`, cursor: id, state: 'queued' });

it.each(['owner', 'run', 'reference', 'cursor', 'duplicate'])(
  'rejects %s material mismatches before Catalog publication', async mismatch => {
    const request = vi.fn(async () => [owner]);
    const publication = createContextObservationPublication({ agentRuntimeRequest: request } as unknown as Pick<KernelClient, 'agentRuntimeRequest'>);
    const material = materialFor(structuredClone(owner), [1]);
    if (mismatch === 'owner') material.owner.anchorId = 'another-input';
    if (mismatch === 'run') material.events[0]!.event.sessionId = 'another-run';
    if (mismatch === 'reference') material.events[0]!.ref = 'another-reference';
    if (mismatch === 'cursor') material.eventCursor = 2;
    if (mismatch === 'duplicate') material.events.push(material.events[0]!);
    const context = { drain: async () => {}, observationsForSource: async () => material };
    await expect(publication.publish(context, run, new AbortController().signal)).rejects.toThrow('Observation material');
    expect(request).toHaveBeenCalledOnce();
  },
);

it('passes the actual cancellation signal and stops waiting for an uncooperative read', async () => {
  let release!: (material: ReturnType<typeof materialFor>) => void;
  const held = new Promise<ReturnType<typeof materialFor>>(resolve => { release = resolve; });
  const request = vi.fn(async () => [owner]);
  const publication = createContextObservationPublication({ agentRuntimeRequest: request } as unknown as Pick<KernelClient, 'agentRuntimeRequest'>);
  const context = { drain: async () => {}, observationsForSource: vi.fn(() => held) };
  const controller = new AbortController();
  const work = publication.publish(context, run, controller.signal);
  const rejected = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(context.observationsForSource).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith('runtime.context.observations.sources', { runId: run.id }, controller.signal);
  controller.abort(); await rejected;
  release(materialFor(owner, [1]));
  await Promise.resolve();
  expect(request).toHaveBeenCalledOnce();
});

it('keeps the acknowledged frontier monotonic when overlapping preparations settle out of order', async () => {
  let release!: (receipts: ReturnType<typeof receiptFor>[]) => void;
  const firstReceipt = new Promise<ReturnType<typeof receiptFor>[]>(resolve => { release = resolve; });
  let admissions = 0;
  const request = vi.fn(async (method: string, params: { events?: Array<{ id: number }> }) => {
    if (method.endsWith('sources')) return [owner];
    if (++admissions === 1) return firstReceipt;
    return params.events!.map(event => receiptFor(owner, event.id));
  });
  const publication = createContextObservationPublication({ agentRuntimeRequest: request } as unknown as Pick<KernelClient, 'agentRuntimeRequest'>);
  let reads = 0;
  const context = { drain: async () => {}, observationsForSource: vi.fn(async (_owner: ContextObservationSource, options: { afterEventId?: number } = {}) => {
    if (++reads === 1) return materialFor(owner, [1]);
    if (reads === 2) return materialFor(owner, [1, 2]);
    return { owner, eventCursor: options.afterEventId!, events: [] };
  }) };
  const first = publication.publish(context, run, new AbortController().signal);
  await vi.waitFor(() => expect(admissions).toBe(1));
  await publication.publish(context, run, new AbortController().signal);
  release([receiptFor(owner, 1)]); await first;
  await publication.publish(context, run, new AbortController().signal);
  expect(context.observationsForSource.mock.calls.map(([, options]) => options?.afterEventId)).toEqual([0, 0, 2]);
});

it('does not acknowledge incomplete original Catalog receipts', async () => {
  let fail = true;
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('sources')) return [owner];
    if (fail) { fail = false; return [receiptFor(owner, 1), receiptFor(owner, 1)]; }
    return [receiptFor(owner, 1), receiptFor(owner, 2)];
  });
  const publication = createContextObservationPublication({ agentRuntimeRequest: request } as unknown as Pick<KernelClient, 'agentRuntimeRequest'>);
  const context = { drain: async () => {}, observationsForSource: vi.fn(async () => materialFor(owner, [1, 2])) };
  await expect(publication.publish(context, run, new AbortController().signal)).rejects.toThrow('original receipt');
  await publication.publish(context, run, new AbortController().signal);
  expect(context.observationsForSource).toHaveBeenLastCalledWith(owner, expect.objectContaining({ afterEventId: 0 }));
});
