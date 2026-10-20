import { AGENT_AVATAR_IDS, type AgentAvatarId } from './agent-runtime.generated.js';

export function isAgentAvatarId(value: unknown): value is AgentAvatarId {
  return typeof value === 'string' && (AGENT_AVATAR_IDS as readonly string[]).includes(value);
}

// Existing identities without a saved choice keep this bank and order as the library grows.
const IDENTITY_AVATARS = ['slope-lilac', 'dome-ivory', 'taper-sage', 'pebble-blue', 'overlap-coral', 'notch-ochre'] as const;
export function agentAvatarForIdentity(identity: string, selected?: string | null): AgentAvatarId {
  if (isAgentAvatarId(selected)) return selected;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
  return IDENTITY_AVATARS[(hash >>> 0) % IDENTITY_AVATARS.length]!;
}
