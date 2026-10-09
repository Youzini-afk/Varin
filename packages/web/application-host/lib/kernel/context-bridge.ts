import { waitWithSignal } from '../cancellation.js';
import type { ContextPolicySnapshot } from './context-settings.js';

export type ContextQuery = {action:'policy';runId:string} | {action:'compact';runId:string;requestId:string;throughId:string;expectedRevision:number;block:boolean};
export type ContextResult = {status:'ready';policy?:ContextPolicySnapshot;published?:boolean;jobRunId?:string} | {status:'failed';code:string};
export interface ContextOwner {
  query(query:ContextQuery,signal:AbortSignal):Promise<ContextResult>;
  close():void;
}
export interface PrivateContextResponse {v:1;kind:'context-response';id:string;kernelEpoch:string;result:ContextResult}
const record = (value:unknown):value is Record<string,unknown> => value !== null && typeof value==='object' && !Array.isArray(value);
const text = (value:unknown):value is string=>typeof value==='string' && value.length>0;
const valid = (value:unknown):value is ContextQuery => record(value) && text(value.runId) && (value.action==='policy'
  || value.action==='compact' && text(value.requestId) && text(value.throughId) && Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision)>=0 && typeof value.block==='boolean');
/** Independent private owner calls; cancellation ends observation of an already accepted job. */
export class ContextBridge {
  private owner?: ContextOwner;
  private readonly active = new Map<string,{epoch:string;controller:AbortController}>();
  constructor(private readonly currentEpoch:()=>string|null,private readonly send:(response:PrivateContextResponse)=>Promise<void>,private readonly transportFailed:()=>void) {}
  setOwner(owner:ContextOwner):void {if(this.owner && this.owner!==owner) throw new Error('Context owner is already connected');this.owner=owner;}
  close():void {for(const entry of this.active.values()) entry.controller.abort();this.active.clear();this.owner?.close();}
  consume(value:unknown):boolean {
    if(!record(value) || !['context-request','context-cancel'].includes(String(value.kind))) return false;
    if(value.v!==1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch!==this.currentEpoch()) return true;
    const id=value.id;const epoch=value.kernelEpoch;
    if(value.kind==='context-cancel') {const entry=this.active.get(id);if(entry?.epoch===epoch) entry.controller.abort();return true;}
    if(this.active.has(id)) return true;
    const controller=new AbortController();const entry={epoch,controller};this.active.set(id,entry);
    const query=value.query;const owner=this.owner;
    void(async()=>{
      let result:ContextResult;
      try {result=valid(query) && owner ? await waitWithSignal(owner.query(query,controller.signal),controller.signal) : {status:'failed',code:'context_owner_unavailable'};}
      catch {result={status:'failed',code:controller.signal.aborted?'context_observation_cancelled':'context_preparation_failed'};}
      if(this.active.get(id)!==entry) return;this.active.delete(id);
      if(epoch!==this.currentEpoch()) return;
      await this.send({v:1,kind:'context-response',id,kernelEpoch:epoch,result});
    })().catch(()=>this.transportFailed());
    return true;
  }
}
