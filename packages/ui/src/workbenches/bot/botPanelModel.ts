import React from 'react';
import type { BotSummary, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import type { BotMatter } from '@varin/protocol';
import type { BotPanelTab } from './botLayout';
import type { BotFigurePose, BotNeed, BotSessionView, BotStateLine, BotTimelineEvent, BotWorkView } from './botPresentation';
import type { BotStageFeed } from './botStageRenderer';
import type { useBotFacts } from './useBotFacts';

/** A row reached from somewhere else: its tab opens and the row flashes once (§5.3). */
export interface BotPanelFocus { tab: BotPanelTab; id: string; token: number }

/** Everything the right panel shows for the selected Bot, and the actions it may take. */
export interface BotPanelModel {
  bot: BotSummary;
  /** The stage figure's pose: the Bot's state refined by her own round and her team (§5.7.1). */
  figure: BotFigurePose;
  /** Her team on the ledge and its moments (§5.7.2). */
  stage: BotStageFeed | null;
  line: BotStateLine;
  sessions: BotSessionView[];
  /** The conversation open in the centre; null while none of the Bot's own conversations is open. */
  session: BotSessionView | null;
  work: BotWorkView[];
  needs: BotNeed[];
  timeline: BotTimelineEvent[];
  facts: ReturnType<typeof useBotFacts>;
  matters: BotMatter[] | null;
  threads: ThreadsAPI | undefined;
  /** No new execution: asleep, archived, deleting or the Host is unreachable. */
  readOnly: boolean;
  busy: boolean;
  focus: BotPanelFocus | null;
  sessionTitle(threadId: string): string;
  focusTab(tab: BotPanelTab, id?: string): void;
  /** Delegated work opens in the ordinary workbench (§6); `origin` is the row lit again on return. */
  openWork(identity: ThreadIdentity, origin?: { tab: BotPanelTab; id: string }): void;
  /** The Bot's own conversations stay here. */
  openSession(identity: ThreadIdentity): void;
  openNeed(need: BotNeed): void;
  changeState(action: 'sleep' | 'wake' | 'retry'): void;
  archiveMatter(matter: BotMatter): void;
  newSession(): void;
  openProfile(): void;
  closeProfile(): void;
  profileOpen: boolean;
  onBotChanged(bot: BotSummary | null): void;
  requestDelete(): void;
  archive(): void;
}

export const BotPanelContext = React.createContext<BotPanelModel | null>(null);

export function useBotPanel(): BotPanelModel {
  const model = React.useContext(BotPanelContext);
  if (!model) throw new Error('Bot panel is not mounted');
  return model;
}
