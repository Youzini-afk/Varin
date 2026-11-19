import type { BotSummary } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { BotFigure } from './BotFigure';

export function GroupAvatar({ bot, name, size }: { bot?: BotSummary; name: string; size: number }) {
  return <span className="group-chat-avatar" style={{ width: size, height: size }} aria-hidden="true">
    {bot ? <BotFigure bot={bot} state="idle" size={Math.round(size * 1.14)} still /> : name.slice(0, 1)}
  </span>;
}

export function GroupAvatarStack({ ids, bots, displayName, size }: { ids: string[]; bots: BotSummary[]; displayName(id: string): string; size: number }) {
  return <span className="group-chat-faces" aria-hidden="true">{ids.length ? ids.map(id => <GroupAvatar key={id} size={size}
    bot={bots.find(bot => bot.id === id)} name={displayName(id)} />) : <span className="group-chat-avatar" style={{ width: size, height: size }}><Icon name="group" className="size-3/5" /></span>}</span>;
}
