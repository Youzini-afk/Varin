import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import type { CollaborationMember } from './collaborationFeed';

export function CollaborationAvatar({ member, identity, size }: { member?: CollaborationMember; identity: string; size: number }) {
  return member?.botId
    ? <BotFigure bot={member.bot} botId={member.botId} size={size} state="idle" still />
    : <AgentAvatar identity={identity} avatar={member?.avatar} role={member?.lead ? 'lead' : undefined} size={size} />;
}
