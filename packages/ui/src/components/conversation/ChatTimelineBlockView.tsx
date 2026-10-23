import React from 'react';
import { motion } from 'motion/react';
import type { ChatTimelineProjection } from './chatTimelineProjection';
import { blockGroupLive, blockGroupSorted, blockGroupDialogue, type ChatTimelineBlock } from './chatTimelineBlocks';
import { ChatDialogueBlock, ChatSortedActivityGroup, ChatTimelineEntryList, ChatTurnUserMessage, type ChatTimelineProps } from './ChatTimelineEntries';
import { ChatTurnAssistantChrome } from './ChatTurnAssistantChrome';
import { useConversationPresentation } from './ConversationContext';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

export const ChatTimelineBlockView = React.memo(({ block, projection, sorted, expanded, activityTransition, onExpandedChange, extensionPresentation, ...props }: Omit<ChatTimelineProps, 'entries' | 'liveAssistant' | 'liveUser' | 'toolExecutions'> & {
  block: ChatTimelineBlock;
  projection: ChatTimelineProjection;
  sorted: boolean;
  expanded: boolean;
  activityTransition?: 'opening' | 'closing';
  onExpandedChange(groupId: string, expanded: boolean): void;
  extensionPresentation: ReadonlyMap<string, () => React.ReactNode>;
}) => {
  const presentation = useConversationPresentation();
  const { t } = useI18n();
  const showThinking = useUIStore(state => state.showReasoningTraces);
  const toolExecutions = presentation.toolExecutions;
  const { cwd, hiddenThinkingLabel, assistantWaiting } = props;
  if (block.kind === 'user') return <div className="chat-message-column py-1.5 bg-background/95" data-turn-entry={block.id} data-turn-id={block.ownerId}>
    <ChatTurnUserMessage {...props} entry={block.turn.userEntry} message={block.turn.user} status={block.turn.liveUser ? props.liveUserStatus : undefined} />
  </div>;
  const { group } = block;
  const liveAssistant = blockGroupLive(group, projection);
  const sortedPresentation = sorted ? blockGroupSorted(group, projection, toolExecutions) : undefined;
  let content: React.ReactNode;
  let bodyKind: string = block.kind;
  let ordinaryActivity = false;
  if (block.kind === 'chrome') content = <ChatTurnAssistantChrome entries={group.entries} liveAssistant={liveAssistant} waiting={assistantWaiting} />;
  else if (block.kind === 'dialogue') {
    const item = blockGroupDialogue(group, projection, showThinking, toolExecutions).find(item => item.id === block.itemId);
    if (!item) return null;
    bodyKind = item.kind === 'text' ? 'prose' : item.kind;
    content = <ChatDialogueBlock item={item} cwd={cwd} sessionId={props.sessionId} executions={toolExecutions}
      results={projection.resultByCallId} active={props.activeRunId === group.runId || assistantWaiting !== undefined || liveAssistant?.stopReason === 'pending'}
      expanded={expanded} onExpandedChange={value => onExpandedChange(block.id, value)} extensionPresentation={extensionPresentation} />;
  }
  else if (block.kind === 'activity-header' || block.kind === 'activity') {
    if (!sortedPresentation) return null;
    const activity = block.kind === 'activity' ? sortedPresentation.activity.filter(item => item.id === block.activityId) : sortedPresentation.activity;
    ordinaryActivity = block.kind === 'activity' && !activity.some(item => item.kind === 'tool' && item.standalone);
    content = <ChatSortedActivityGroup cwd={cwd} executionById={toolExecutions} hiddenThinkingLabel={hiddenThinkingLabel || t('chat.reasoningTrace.thinking')}
      resultByCallId={projection.resultByCallId} projection={{ ...sortedPresentation, activity }}
      part={block.kind === 'activity-header' ? 'header' : 'body'} expanded={block.kind === 'activity' || expanded}
      onExpandedChange={value => onExpandedChange(group.id, value)} />;
  } else {
    content = <ChatTimelineEntryList {...props} toolExecutions={toolExecutions} outputDurationsMs={presentation.outputDurationsMs}
      entries={block.kind === 'entry' ? [block.entry] : block.kind === 'footer' ? group.entries : []}
      liveAssistant={block.kind === 'footer' || block.kind === 'live-assistant' ? liveAssistant : undefined}
      turnActive={props.activeRunId === group.runId || assistantWaiting !== undefined || liveAssistant?.stopReason === 'pending'}
      projectedResultByCallId={projection.resultByCallId} part={block.kind === 'footer' ? 'footer' : 'body'} sortedPresentation={sortedPresentation} extensionPresentation={extensionPresentation} />;
  }
  const body = <div className="chat-message-column conversation-block" data-conversation-block={bodyKind} data-turn-entry={block.id} data-turn-id={block.ownerId}
    data-conversation-entry-id={block.kind === 'activity' ? block.sourceId : undefined}
    data-conversation-message-role={block.kind === 'chrome' || block.kind === 'activity' ? 'assistant' : undefined}>{content}</div>;
  return ordinaryActivity ? <motion.div initial={activityTransition === 'opening' ? { height: 0, opacity: 0 } : false}
    animate={activityTransition === 'closing' ? { height: 0, opacity: 0 } : { height: 'auto', opacity: 1 }}
    transition={{ duration: activityTransition ? .2 : 0, ease: [.22, 1, .36, 1] }}
    inert={activityTransition === 'closing' ? true : undefined} style={{ overflow: activityTransition ? 'hidden' : undefined }}>{body}</motion.div> : body;
});
