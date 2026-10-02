import type { JsonValue, RuntimeContextTarget } from '@varin/protocol';
import { getRuntimeKey } from '@varin/application-client';
import { getPiRuntimeConnection } from './client';

export const listPiAgentProviders = async (target: RuntimeContextTarget) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('agentProvider.list', target);
};

export const runPiAgentProviderAction = async (
  target: RuntimeContextTarget,
  providerId: string,
  action: string,
  agentId?: string,
  input?: JsonValue,
  expectedRuntimeKey = getRuntimeKey(),
) => {
  const { client, runtimeKey } = await getPiRuntimeConnection();
  if (runtimeKey !== expectedRuntimeKey || getRuntimeKey() !== expectedRuntimeKey) throw new Error('Runtime changed before the agent update');
  return client.request('agentProvider.action', {
    ...target,
    action,
    providerId,
    ...(agentId === undefined ? {} : { agentId }),
    ...(input === undefined ? {} : { input }),
  });
};
