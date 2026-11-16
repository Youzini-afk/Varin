/** Existing Host configuration identities, not another executable registry. */
import { createHash } from 'node:crypto';
import type { SourceResourceOwner } from '@varin/protocol';
import type { ExternalAgentSettings } from '@varin/application-client';
import type { ChildExecutor } from '../kernel/protocol.generated.js';
import type { ExternalAgentsService } from './service.js';
import { parseSourceResourceOwner } from '../kernel/thread-sources.js';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])) : value;
export function executorChoices(settings: ExternalAgentSettings, owner: SourceResourceOwner): ChildExecutor[] {
  return settings.agents.map(agent=>({reference:'exec:'+createHash('sha256').update(JSON.stringify(canonical([owner,agent.id]))).digest('hex').slice(0,12).toUpperCase(),
    name:agent.name,availability:agent.availability ?? (agent.enabled?'enabled':'disabled'),
    binding:{configuration_id:agent.id,harness:agent.harness,resource_owner:owner,launch:{command:agent.command,args:[...agent.args]}}}));
}

export async function inspectExecutors(service: Pick<ExternalAgentsService, 'settings' | 'inspectExecutor'>, input: Record<string, unknown>, signal: AbortSignal) {
  if (!['list','inspect','detect','resolve'].includes(String(input.action))) throw new Error('Invalid executor query');
  const owner=parseSourceResourceOwner(input.resourceOwner);
  // Configuration reads do not probe programs or initialize sessions.
  const choices=executorChoices(await service.settings(signal,owner),owner)
    .filter(choice=>input.executor == null || input.executor === choice.reference || input.executor === choice.binding.configuration_id)
    .filter(choice=>typeof input.query !== 'string' || choice.name.toLowerCase().includes(input.query.toLowerCase()) || choice.binding.configuration_id.toLowerCase().includes(input.query.toLowerCase()));
  if (input.executor != null && choices.length!==1) throw new Error('Executor reference is unavailable or ambiguous on the selected Host');
  // Only this private trusted query returns launch metadata to the dispatch owner.
  if (input.action==='resolve') {
    if (choices.length!==1) throw new Error('A concrete executor is required');
    return {choice:choices[0]};
  }
  const executors: Record<string,unknown>[] = input.includeVarin ? [{ref:'varin',name:'Varin',host:input.host,availability:'enabled',backend:'native'}] : [];
  for (const choice of choices) {
    try {
      const observed = await service.inspectExecutor(choice.binding.configuration_id, input.action === 'detect', signal, owner);
      executors.push({...observed,ref:choice.reference,host:input.host});
    } catch {
      signal.throwIfAborted();
      executors.push({ref:choice.reference,name:choice.name,host:input.host,configurationId:choice.binding.configuration_id,installation:{status:'unknown'},connection:'unknown',authentication:'unknown',error:'The selected executor configuration could not be inspected on its execution Host'});
    }
  }
  return {executors,hosts:input.hosts};
}
