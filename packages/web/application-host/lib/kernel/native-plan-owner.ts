import { withNativePlanSelection } from './native-plan-resolution.js';
import type { NativeRuntimeClient } from './native-runtime-client.js';
/** Private kernel requests already carry the admitted Catalog identity. */
import { renderTodoPlan, isTodoItemStatus, type TodoItem, type NativePlanView, type NativePlanOrigin, type NativePlanSnapshot, type NativePlanMutationResult } from '@varin/protocol';
import { KnowledgeMutationError, type KnowledgeStore } from '../knowledge/store.js';
export interface NativePlanQuery {
  action: 'read' | 'mutate' | 'receipt';
  view: NativePlanView;
  origin: Extract<NativePlanOrigin, {kind:'tool'}>;
  arguments: { action:'read' } | { action:'update'; expectedRef:string|null; items:TodoItem[] };
}
export type NativePlanResult = { status:'ready'; plan:NativePlanSnapshot|null; mutation?:NativePlanMutationResult|null }
  | { status:'rejected'|'unknown'; message:string };
export type NativePlanOwner = (query:NativePlanQuery, signal:AbortSignal)=>Promise<NativePlanResult>;
export function createNativePlanOwner(getStore:()=>Promise<KnowledgeStore>, runtime: NativeRuntimeClient):NativePlanOwner {
  return async (query, signal) => {
    try {
      signal.throwIfAborted();
      const args = query.arguments;
      if (!query.view || query.origin?.kind !== 'tool' || !args) throw new KnowledgeMutationError('invalid','Native plan identity is required');
      if (query.action === 'read') {
        if (args.action !== 'read' || Object.keys(args).some(key=>key!=='action')) throw new KnowledgeMutationError('invalid','Invalid native plan read');
        const store = await getStore();
        return {status:'ready',plan:await withNativePlanSelection(store,runtime,query.view,selection=>store.readNativePlan(query.view,selection),signal)};
      }
      if (args.action !== 'update' || Object.keys(args).some(key=>!['action','expectedRef','items'].includes(key))
        || !(args.expectedRef === null || typeof args.expectedRef === 'string' && args.expectedRef.length > 0)
        || !Array.isArray(args.items) || args.items.some(item=>!item || typeof item.text !== 'string'
          || !isTodoItemStatus(item.status) || Object.keys(item).some(key=>!['text','status'].includes(key)))) {
        throw new KnowledgeMutationError('invalid','Invalid native plan update');
      }
      const input = {view:query.view,origin:query.origin,expectedRef:args.expectedRef,content:renderTodoPlan(args.items)};
      const store=await getStore();
      signal.throwIfAborted();
      const prior = await store.readNativePlanMutation(input);
      const mutation = query.action === 'receipt' || prior ? prior
        : await withNativePlanSelection(store,runtime,query.view,selection=>store.mutateNativePlan({...input,selection}),signal);
      return {status:'ready',plan:mutation?.plan??null,mutation};
    } catch(error) {
      return {status:error instanceof KnowledgeMutationError?'rejected':'unknown',
        message:error instanceof KnowledgeMutationError?'Native plan request was rejected':'Native plan owner could not confirm the result'};
    }
  };
}
