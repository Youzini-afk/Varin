import { withPlanSelection } from './plan-resolution.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
/** Private kernel requests already carry the admitted Catalog identity. */
import { renderTodoPlan, isTodoItemStatus, type TodoItem, type PlanView, type PlanOrigin, type PlanSnapshot, type PlanMutationResult } from '@varin/protocol';
import { KnowledgeMutationError, type KnowledgeStore } from '../knowledge/store.js';
export interface PlanQuery {
  action: 'read' | 'mutate' | 'receipt';
  view: PlanView;
  origin: Extract<PlanOrigin, {kind:'tool'}>;
  arguments: { action:'read' } | { action:'update'; expectedRef:string|null; items:TodoItem[] };
}
export type PlanResult = { status:'ready'; plan:PlanSnapshot|null; mutation?:PlanMutationResult|null }
  | { status:'rejected'|'unknown'; message:string };
export type PlanOwner = (query:PlanQuery, signal:AbortSignal)=>Promise<PlanResult>;
export function createPlanOwner(getStore:()=>Promise<KnowledgeStore>, runtime: AgentRuntimeClient):PlanOwner {
  return async (query, signal) => {
    try {
      signal.throwIfAborted();
      const args = query.arguments;
      if (!query.view || query.origin?.kind !== 'tool' || !args) throw new KnowledgeMutationError('invalid','Plan identity is required');
      if (query.action === 'read') {
        if (args.action !== 'read' || Object.keys(args).some(key=>key!=='action')) throw new KnowledgeMutationError('invalid','Invalid plan read');
        const store = await getStore();
        return {status:'ready',plan:await withPlanSelection(store,runtime,query.view,selection=>store.readPlan(query.view,selection),signal)};
      }
      if (args.action !== 'update' || Object.keys(args).some(key=>!['action','expectedRef','items'].includes(key))
        || !(args.expectedRef === null || typeof args.expectedRef === 'string' && args.expectedRef.length > 0)
        || !Array.isArray(args.items) || args.items.some(item=>!item || typeof item.text !== 'string'
          || !isTodoItemStatus(item.status) || Object.keys(item).some(key=>!['text','status'].includes(key)))) {
        throw new KnowledgeMutationError('invalid','Invalid plan update');
      }
      const input = {view:query.view,origin:query.origin,expectedRef:args.expectedRef,content:renderTodoPlan(args.items)};
      const store=await getStore();
      signal.throwIfAborted();
      const prior = await store.readPlanMutation(input);
      const mutation = query.action === 'receipt' || prior ? prior
        : await withPlanSelection(store,runtime,query.view,selection=>store.mutatePlan({...input,selection}),signal);
      return {status:'ready',plan:mutation?.plan??null,mutation};
    } catch(error) {
      return {status:error instanceof KnowledgeMutationError?'rejected':'unknown',
        message:error instanceof KnowledgeMutationError?'Plan request was rejected':'Plan owner could not confirm the result'};
    }
  };
}
