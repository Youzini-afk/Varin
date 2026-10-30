import React from 'react';
import { agentAvatarForIdentity } from '@varin/protocol';
import { cn } from '@/lib/utils';
import { AGENT_AVATAR_ART } from './agent-avatar-art';
import { projectLeadSvg } from '@/components/companion/projectLeadArt';

/** Below this size the lead's cape and collar no longer read; the figure keeps its plain face
 * and wears only the lead's clasp, so a small row still matches the large portrait. */
export const AGENT_LEAD_PORTRAIT_MIN_SIZE = 40;

/** The caller supplies the original Agent identity, shared by every presentation of that Agent.
 * role="lead" dresses the same figure as a task lead; it never changes the saved avatar. */
export function AgentAvatar({ identity, avatar, className, size = 24, label, role }: {
  identity: string; avatar?: string | null | undefined; className?: string; size?: number; label?: string; role?: 'lead';
}) {
  const id = agentAvatarForIdentity(identity, avatar);
  const art = AGENT_AVATAR_ART[id];
  const portrait = role === 'lead' && size >= AGENT_LEAD_PORTRAIT_MIN_SIZE;
  // Static, locally authored art for a validated avatar id; each instance has its own gradient ids.
  const markup = React.useMemo(() => portrait ? projectLeadSvg(id, 0, 0, size, { layer: 'portrait' }) : null, [portrait, id, size]);
  const a11y = { 'aria-hidden': label ? undefined : true, role: label ? 'img' : undefined, 'aria-label': label } as const;
  if (markup) return <span className={cn('inline-flex shrink-0', className)} style={{ width: size, height: size }}
    data-agent-avatar={id} data-agent-role="lead" {...a11y} dangerouslySetInnerHTML={{ __html: markup }} />;
  return <svg viewBox="0 0 64 64" width={size} height={size} className={cn('shrink-0', className)}
    data-agent-avatar={id} data-agent-role={role} {...a11y} focusable="false">
    {art.accent && <path fill={art.accent.color} d={art.accent.path} />}
    <path fill={art.color} d={art.body} />
    <path fill="#202326" d={art.eyes} />
    {art.eyeStroke && <path fill="none" stroke="#202326" strokeWidth={4} strokeLinecap="round" d={art.eyeStroke} />}
    {role === 'lead' && <path d="M32 46.5 l7.5 7.5 l-7.5 7.5 l-7.5 -7.5 Z" fill="#fffaf0" stroke="#c8a267" strokeWidth={3.2} strokeLinejoin="round" />}
  </svg>;
}
