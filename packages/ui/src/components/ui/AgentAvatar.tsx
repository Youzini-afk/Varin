import React from 'react';
import { agentAvatarForIdentity } from '@varin/protocol';
import { cn } from '@/lib/utils';
import { AGENT_AVATAR_ART } from './agent-avatar-art';

/** The caller supplies the original Agent identity, shared by every presentation of that Agent. */
export function AgentAvatar({ identity, avatar, className, size = 24, label }: {
  identity: string; avatar?: string | null | undefined; className?: string; size?: number; label?: string;
}) {
  const id = agentAvatarForIdentity(identity, avatar);
  const art = AGENT_AVATAR_ART[id];
  return <svg viewBox="0 0 64 64" width={size} height={size} className={cn('shrink-0', className)}
    data-agent-avatar={id} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} focusable="false">
    {art.accent && <path fill={art.accent.color} d={art.accent.path} />}
    <path fill={art.color} d={art.body} />
    <path fill="#202326" d={art.eyes} />
    {art.wink && <path fill="none" stroke="#202326" strokeWidth={4} strokeLinecap="round" d={art.wink} />}
  </svg>;
}
