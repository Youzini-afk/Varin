import { ChatAssistantUsageFooter } from './ChatAssistantUsageFooter';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import React from 'react';
import { InteractiveUiCard } from '@/components/interactive-ui/InteractiveUiCard';
import type { JsonValue } from '@varin/protocol';
import type { ChatAssistantMessage, ChatSessionEntry, ChatSessionMessageEntry, ChatThinkingContent, ChatToolCall, ChatToolResultMessage, ChatUserContent, ChatUserMessage } from './types';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { renderTerminalOutput } from '@/components/chat/message/parts/toolOutput';
import { getApplyPatchFileEntries } from '@/components/chat/message/parts/toolDiffUtils';
import { getToolSummary, groupToolCalls } from '@/components/chat/message/parts/toolSummary';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
import { ConversationPreviewContext, useOptionalConversationPresentation } from './ConversationContext';
import { EntryExtras } from './EntryExtras';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { PatchHunkReview } from '@/components/workbench/PatchHunkReview';
import { useUIStore } from '@/stores/useUIStore';
import type {
  ChatSessionSubmissionStatus,
  ChatToolExecutionState,
} from './types';
import {
  renderFirstWorkbenchMatch,
  useWorkbenchMatchRenderers,
} from '@/lib/extensions/workbench-registry';
import {
  projectToolCalls,
  chatContentText,
  type ToolCallPresentation,
} from './extensionPresentation';
import {
  projectChatTimeline,
} from './chatTimelineProjection';
import type { ChatAssistantWaitingPresentation } from './chatAssistantWaiting';
import {
  CHAT_SORTED_LIVE_ASSISTANT_ID,
  projectChatSortedTurn,
  type ChatSortedTurnProjection,
} from './chatSortedTurnProjection';
import { ChatMoreButton, ChatTextSource } from './ChatContextMenu';
import { ChatFileChangePreview, ChatFileChangePreviewScope } from './ChatFileChangePreview';
import { fileChangePhase, isFileChangeTool, projectFileChanges } from './fileChangePreview';
import { ChatExploreCard, ChatExploreScope } from './ChatExploreCard';
import { explorePresentation } from './explorePresentation';
import { ChatThreadMessageCard } from './ChatThreadMessageCard';
import { ChatReceivedThreadMessage } from './ChatReceivedThreadMessage';
import { ChatTurnUsageFooter } from './ChatTurnUsageFooter';
import { ChatCollapsibleUserContent } from './ChatCollapsibleUserContent';
import { ChatTurnChangedFiles } from './ChatTurnChangedFiles';
import { ChatToolResultPreview } from './ChatToolResultPreview';
import { assistantMessagesForTurn } from './usagePresentation';
import { timelinePresentationCache } from './timelinePresentationCache';

export interface ChatTimelineProps {
  navigation?: {
    runs: readonly import('@varin/application-client').ThreadHistoryRun[];
    readPreview(runId: string, signal: AbortSignal): Promise<string>;
    ensureItem(entryId: string, signal: AbortSignal): Promise<void>;
    error?: string;
    retry(): Promise<void>;
  };
  earlierHistory?: {
    available: boolean;
    loading: boolean;
    error?: string;
    latencyMs: number;
    load(retry?: boolean): Promise<void>;
  };
  header?: React.ReactNode;
  footer?: React.ReactNode;
  compactionStatus?: 'requested' | 'running' | 'retrying' | 'ready' | 'applying' | 'failed';
  assistantWaiting?: ChatAssistantWaitingPresentation;
  cwd: string;
  entries: readonly ChatSessionEntry[];
  forkBusyEntryId?: string | null;
  hiddenThinkingLabel?: string;
  leafId?: string | null;
  liveAssistant?: ChatAssistantMessage;
  liveUser?: ChatUserMessage;
  liveUserStatus?: ChatSessionSubmissionStatus;
  onFork?(entry: ChatSessionMessageEntry): void;
  onOpenCompaction?(): void;
  onApplyCompaction?(): void;
  onOpenThread?(entry: ChatSessionMessageEntry, options: { carryBlocks: boolean }): void;
  onRecover?(entry: ChatSessionMessageEntry): void;
  onScrollContainerChange?(element: HTMLElement | null): void;
  recoveryBusyEntryId?: string | null;
  sessionId: string;
  threadBusyEntryId?: string | null;
  toolExecutions: Record<string, ChatToolExecutionState>;
}

const imageUrl = (content: Extract<ChatUserContent, { type: 'image' }>): string => (
  `data:${content.mimeType};base64,${content.data}`
);

const jsonText = (value: JsonValue): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

const formatUsd = (value: number): string => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumSignificantDigits: 6,
}).format(value);

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
};

const thinkingPreview = (value: string): string => {
  const normalized = value
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 79).trimEnd()}…`;
};

const ChatUserContentView: React.FC<{
  content: string | ChatUserContent[];
  messageId: string;
  variant?: 'assistant' | 'tool';
  plain?: boolean;
}> = ({ content, messageId, variant = 'assistant', plain = false }) => {
  const preview = React.useContext(ConversationPreviewContext);
  const parts: ChatUserContent[] = typeof content === 'string'
    ? [{ text: content, type: 'text' }]
    : content;
  return (
    <>
      {parts.map((part, index) => (
        part.type === 'text' ? (
          <ChatTextSource key={`${messageId}:text:${index}`} entryId={messageId} text={part.text}
            offset={parts.slice(0, index).filter((part) => part.type === 'text').reduce((total, part) => total + part.text.length + 1, 0)}>
            {plain ? <div className="markdown-content whitespace-pre-wrap break-words">{part.text}</div> : <MarkdownRenderer
              content={part.text}
              messageId={`${messageId}:text:${index}`}
              variant={variant}
              enableFileReferences={!preview}
            />}
          </ChatTextSource>
        ) : (
          <a
            key={`${messageId}:image:${index}`}
            href={imageUrl(part)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block w-fit max-w-full overflow-hidden rounded-lg border border-border/70 bg-background"
          >
            <img
              src={imageUrl(part)}
              alt={part.mimeType}
              className="max-h-[32rem] max-w-full object-contain"
            />
          </a>
        )
      ))}
    </>
  );
};

const RawJsonDetails: React.FC<{
  label?: string;
  value: JsonValue;
}> = ({ label = 'raw details', value }) => (
  <details className="group/details">
    <summary className="cursor-pointer select-none typography-micro text-muted-foreground hover:text-foreground">
      {label}
    </summary>
    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
      {jsonText(value)}
    </pre>
  </details>
);

const OpenThreadButton: React.FC<{
  busy: boolean;
  disabled: boolean;
  entry: ChatSessionMessageEntry;
  onOpen(entry: ChatSessionMessageEntry, options: { carryBlocks: boolean }): void;
}> = ({ busy, disabled, entry, onOpen }) => {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              aria-label={t('chat.messageBody.actions.openThreadAria')}
            >
              <Icon name={busy ? 'loader-4' : 'chat-new'} className={cn('size-3.5', busy && 'animate-spin')} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('chat.messageBody.actions.openThread')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={() => onOpen(entry, { carryBlocks: true })}>
          <Icon name="chat-new" className="mr-2 size-3.5" />
          {t('chat.messageBody.actions.openThread')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpen(entry, { carryBlocks: false })}>
          <Icon name="chat-1" className="mr-2 size-3.5" />
          {t('chat.messageBody.actions.openThreadWithoutBlocks')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ToolCallRow: React.FC<{ call: ToolCallPresentation }> = ({ call }) => (
  <div>
    <span className="font-mono">{call.name}</span>{call.model ? <span> · {call.model}</span> : null} · {call.status}{call.durationMs === undefined ? '' : ` · ${formatDuration(call.durationMs)}`}{call.cost === undefined ? '' : ` · ${formatUsd(call.cost)}`}
    {call.error ? <p className="break-words text-[var(--status-error)]">{call.error}</p> : null}
  </div>
);

const ToolResultContent: React.FC<{
  messageId: string;
  result: ChatToolResultMessage;
}> = ({ messageId, result }) => {
  const { t } = useI18n();
  const calls = projectToolCalls(result);
  return (
    <div className="space-y-2">
      <ChatUserContentView content={result.content} messageId={messageId} variant="tool" />
      <ChatToolResultPreview result={result} />
      <EntryExtras itemId={result.historyId} />
      {result.usage && <ChatAssistantUsageFooter usage={result.usage} />}
      {calls ? <details className="typography-meta text-muted-foreground">
        <summary className="cursor-pointer">{t('chat.timeline.tools.callCount', { count: calls.calls.length })}{calls.complete ? '' : ` · ${t('chat.timeline.tools.incompleteRecord')}`}</summary>
        <div className="mt-2 space-y-1 border-l border-border/60 pl-3">
          {calls.calls.map(call => <ToolCallRow key={call.id} call={call} />)}
        </div>
      </details> : null}
      {result.details !== undefined ? (
        <RawJsonDetails label="details" value={result.details} />
      ) : null}
    </div>
  );
};

// A tool keeps its disclosure choice when a live message becomes a persisted
// entry, or when an adjacent read makes it part of a group. This cache belongs
// to the mounted turn, never to execution state or the native session history.
const ToolDisclosureContext = React.createContext<Map<string, boolean> | null>(null);
const TimelineSessionContext = React.createContext<string | undefined>(undefined);

export const ChatToolDisclosureScope: React.FC<{ children: React.ReactNode; sessionId: string }> = ({ children, sessionId }) => {
  const parent = React.useContext(ToolDisclosureContext);
  const [choices] = React.useState(() => timelinePresentationCache(sessionId, 'tools', () => new Map<string, boolean>()));
  if (parent) return <>{children}</>;
  return <TimelineSessionContext.Provider value={sessionId}><ToolDisclosureContext.Provider value={choices}>
    <ChatExploreScope sessionId={sessionId}><ChatFileChangePreviewScope sessionId={sessionId}>{children}</ChatFileChangePreviewScope></ChatExploreScope>
  </ToolDisclosureContext.Provider></TimelineSessionContext.Provider>;
};

const ChatToolDisclosure: React.FC<{
  children: React.ReactNode;
  className: string;
  disclosureId: string;
  initiallyExpanded?: boolean;
}> = ({ children, className, disclosureId, initiallyExpanded = false }) => {
  const choices = React.useContext(ToolDisclosureContext);
  const [expanded, setExpanded] = React.useState(() => choices?.get(disclosureId) ?? initiallyExpanded);
  React.useEffect(() => {
    if (!choices?.has(disclosureId)) setExpanded(initiallyExpanded);
  }, [choices, disclosureId, initiallyExpanded]);
  return (
    <details className={cn('workbench-disclosure', className)} open={expanded} data-conversation-tool-disclosure={disclosureId}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        choices?.set(disclosureId, open);
        setExpanded(open);
      }}>
      {children}
    </details>
  );
};

function toolStatus(result: ChatToolResultMessage | undefined, execution: ChatToolExecutionState | undefined): ChatToolExecutionState['status'] {
  if (result?.status === 'background') return execution && execution.status !== 'running' ? execution.status : 'background';
  return result ? result.status ?? (result.isError ? 'error' : 'success') : execution?.status ?? 'unknown';
}

const ChatToolStatus: React.FC<{ status: ChatToolExecutionState['status'] }> = ({ status }) => {
  const { t } = useI18n();
  return <span key={status} className={cn('workbench-status-arrival shrink-0 typography-micro', status === 'success' && 'sr-only', status === 'error' && 'text-[var(--status-error)]')}>
    {t(`chat.timeline.tools.${status}`)}
  </span>;
};

const ChatToolCard: React.FC<{
  call: ChatToolCall;
  cwd: string;
  generating?: boolean;
  execution?: ChatToolExecutionState;
  executionById?: Record<string, ChatToolExecutionState>;
  result?: ChatToolResultMessage;
}> = ({ call, cwd, generating = false, execution, executionById, result }) => {
  const { t } = useI18n();
  const expandCommands = useUIStore(state => state.showExpandedBashTools);
  const expandEdits = useUIStore(state => state.showExpandedEditTools);
  const preview = React.useContext(ConversationPreviewContext);
  const toolRenderers = useWorkbenchMatchRenderers<{
    call: ChatToolCall;
    cwd: string;
    execution?: ChatToolExecutionState;
    result?: ChatToolResultMessage;
  }>('tool-renderer', 'chat.timeline.tools', !preview);
  const sessionId = React.useContext(TimelineSessionContext);
  const conversation = useOptionalConversationPresentation();
  const extensionRendered = preview ? undefined : renderFirstWorkbenchMatch(toolRenderers, { call, cwd, execution, result });
  const fileChanges = React.useMemo(() => extensionRendered === undefined ? projectFileChanges(call, generating) : [], [call, generating, extensionRendered]);
  const nested = Object.values(executionById ?? {}).filter(child => child.parentToolCallId === call.id);
  if (extensionRendered !== undefined) return <>{extensionRendered}</>;
  if (call.name === 'render_ui') {
    const projected = conversation?.uiCards?.[call.id];
    if (projected?.compact) return <details className="my-1 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('ui.content.title')} · {t(projected.result?.isError ? 'ui.content.unsaved' : projected.result ? 'ui.content.updated' : 'ui.content.making')}</summary><RawJsonDetails value={projected.result?.details ?? call.arguments} /></details>;
    return <InteractiveUiCard call={projected?.call ?? call} ownerCallId={call.id} cwd={cwd}
      generating={projected?.call.rawArguments !== undefined && !projected.call.interrupted || generating}
      execution={projected ? conversation?.toolExecutions[projected.call.id] : execution} result={projected ? projected.result : result} />;
  }
  const mutationPhase = isFileChangeTool(call.name) ? fileChangePhase(execution, result, generating) : undefined;
  const status = mutationPhase === 'failed' || mutationPhase === 'partial' ? 'error' : toolStatus(result, execution);
  const transientOutput = execution?.result ?? execution?.partialResult;
  const liveModels = projectToolCalls({ toolName: call.name,
    ...(transientOutput === undefined ? {} : { details: transientOutput }),
  }, execution?.status === 'running')?.calls.filter(row => row.name === 'models.classify' || row.name === 'models.generateImages') ?? [];
  const applyPatchFiles = call.name === 'apply_patch'
    ? getApplyPatchFileEntries(result?.details ?? transientOutput)
    : [];
  const details = result?.details ?? transientOutput;
  const compactSummary = getToolSummary({
    toolName: call.name,
    arguments: call.arguments,
    details,
  }).text;
  const harnessShellId = call.name === 'process_spawn' && conversation?.api.processes && execution
    && typeof call.arguments === 'object' && call.arguments && !Array.isArray(call.arguments) && call.arguments.mode === 'pty' ? call.id : null;
  const command = typeof call.arguments === 'object' && call.arguments && !Array.isArray(call.arguments)
    ? String((call.arguments as Record<string, unknown>).command ?? '')
    : '';
  if (call.name === 'send') return <ChatThreadMessageCard call={call} result={result} sessionId={sessionId} failed={status === 'error'} />;
  if (call.name === 'code_retrieval') return <ChatExploreCard call={call} cwd={cwd} execution={execution}
    result={result} generating={generating} rawDetails={<>
      <pre className="overflow-auto whitespace-pre-wrap break-words font-mono typography-micro">{jsonText(call.arguments)}</pre>
      {result ? <ToolResultContent messageId={`tool-result:${call.id}`} result={result} />
        : transientOutput !== undefined ? <RawJsonDetails value={transientOutput} /> : null}
    </>} />;
  return (
    <>
    {fileChanges.map((file, index) => <ChatFileChangePreview key={`${index}:${file.path}`} file={file}
      previewId={`${call.id}:${index}:${file.path}`}
      phase={fileChangePhase(execution, result, generating, file.path)}
      onOpen={file.operation === 'delete' || !conversation ? undefined : () => void conversation.openFile(call.id, file.path)} />)}
    <ChatToolDisclosure
      disclosureId={`tool:${call.id}`}
      initiallyExpanded={(call.name === 'process_spawn' && expandCommands) || (isFileChangeTool(call.name) && expandEdits)}
      className={cn(
        'group',
        'my-1',
        status === 'error' && 'text-[var(--status-error)]',
      )}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
        <Icon
          name={fileChanges.length ? 'code-sslash' : status === 'running' ? 'loader-4' : status === 'error' || status === 'unknown' ? 'error-warning' : status === 'cancelled' ? 'close' : status === 'background' ? 'time' : status === 'waiting' ? 'question' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            !fileChanges.length && status === 'running' && 'animate-spin',
            status === 'error' && 'text-[var(--status-error)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={`${call.name}: ${compactSummary || call.name}`}>{fileChanges.length ? t('chat.fileChange.details') : compactSummary || call.name}</span>
        {harnessShellId && conversation ? (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 typography-micro text-foreground hover:bg-interactive-hover"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const endpointGeneration = getRuntimeEndpointGeneration();
              const [, requestId, callId] = JSON.parse(call.id) as string[];
              void conversation.api.processes!.openTerminal({ ...conversation.identity, operationId: `${requestId}:tool:${callId}` }).then(binding => {
                if (endpointGeneration !== getRuntimeEndpointGeneration()) return;
                attachProcessTerminal(binding.cwd, binding.sessionId, command, binding.resourceOwner, { identity: conversation.identity, operationId: binding.operationId, processId: binding.processId, endpointGeneration });
              }).catch(error => toast.error(String(error)));
            }}
          >
            {t('chat.timeline.tools.openTerminal')}
          </button>
        ) : null}
        {!fileChanges.length ? <ChatToolStatus status={status} /> : null}
        <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="ml-2 space-y-3 border-l border-border/60 py-2 pl-3">
        {!result && nested.length ? <div className="space-y-1 typography-meta text-muted-foreground" aria-live="polite">
          {nested.map(child => <div key={child.toolCallId}><span className="font-mono">{child.name}</span> · {child.status}</div>)}
        </div> : null}
        {!result && liveModels.length ? <div className="space-y-1 typography-meta text-muted-foreground" aria-live="polite">
          {liveModels.map(row => <ToolCallRow key={row.id} call={row} />)}
        </div> : null}
        <div>
          <p className="mb-1 typography-micro font-medium text-muted-foreground">arguments</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
            {jsonText(call.arguments)}
          </pre>
        </div>
        {result ? (
          <ToolResultContent messageId={`tool-result:${call.id}`} result={result} />

        ) : transientOutput !== undefined ? (
          <div>
            <p className="mb-1 typography-micro font-medium text-muted-foreground">output</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
              {jsonText(transientOutput)}
            </pre>
          </div>
        ) : null}
        {applyPatchFiles.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {applyPatchFiles.map((file) => (
                <button
                  key={file.filePath}
                  type="button"
                  disabled={file.deleted || !conversation}
                  onClick={() => void conversation?.openFile(call.id, file.filePath)}
                  className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:cursor-default disabled:opacity-50"
                >
                  <Icon name="file-code" className="size-3.5 shrink-0" />
                  <span className="max-w-64 truncate">{file.filePath}</span>
                </button>
              ))}
            </div>
            {applyPatchFiles.map((file) => (
              file.patch && conversation ? (
                <PatchHunkReview
                  key={`review:${file.filePath}`}
                  resolveTarget={() => conversation.fileTarget(call.id, file.filePath)}
                  thread={conversation.identity}
                  patch={file.patch}
                  {...(call.id ? { toolCallId: call.id } : {})}
                />
              ) : null
            ))}
          </div>
        ) : null}
      </div>
    </ChatToolDisclosure>
    </>
  );
};

const ChatReadOnlyToolGroup: React.FC<{
  calls: ChatToolCall[];
  cwd: string;
  executionById: Record<string, ChatToolExecutionState>;
  resultByCallId: ReadonlyMap<string, ChatToolResultMessage>;
}> = ({ calls, cwd, executionById, resultByCallId }) => {
  const { t } = useI18n();
  const disclosureChoices = React.useContext(ToolDisclosureContext);
  const states = calls.map((call) => {
    const result = resultByCallId.get(call.id);
    return toolStatus(result, executionById[call.id]);
  });
  const status = states.includes('running') ? 'running' : states.includes('error') ? 'error' : states.includes('unknown') ? 'unknown' : states.includes('cancelled') ? 'cancelled' : states.includes('waiting') ? 'waiting' : states.includes('background') ? 'background' : 'success';
  const counts = { reads: 0, searches: 0, inspections: 0 };
  for (const call of calls) {
    const name = call.name.toLowerCase().replace(/:\d+$/, '');
    if (name === 'file_read') counts.reads += 1;
    else if (['file_search', 'file_list', 'websearch'].includes(name)) counts.searches += 1;
    else counts.inspections += 1;
  }
  const summary = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => t(`chat.timeline.tools.${kind}`, { count: counts[kind] }))
    .join(' · ');
  return (
    <ChatToolDisclosure disclosureId={`group:${calls[0]!.id}`}
      initiallyExpanded={calls.some((call) => disclosureChoices?.get(`tool:${call.id}`))}
      className="group/tools my-1">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
        <Icon
          name={status === 'running' ? 'loader-4' : status === 'error' || status === 'unknown' ? 'error-warning' : status === 'cancelled' ? 'close' : status === 'background' ? 'time' : status === 'waiting' ? 'question' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            status === 'running' && 'animate-spin',
            status === 'error' && 'text-[var(--status-error)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={summary}>{summary}</span>
        {status === 'running' && states.includes('error') ? <ChatToolStatus status="error" /> : null}
        <ChatToolStatus status={status} />
        <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground transition-transform group-open/tools:rotate-180" />
      </summary>
      <div className="ml-2 border-l border-border/60 py-1 pl-3">
        {calls.map((call) => (
          <ChatToolCard
            key={call.id}
            call={call}
            cwd={cwd}
            execution={executionById[call.id]}
            executionById={executionById}
            result={resultByCallId.get(call.id)}
          />
        ))}
      </div>
    </ChatToolDisclosure>
  );
};

const MetaEntry: React.FC<{
  children: React.ReactNode;
  icon: React.ComponentProps<typeof Icon>['name'];
}> = ({ children, icon }) => (
  <div className="mx-auto flex w-fit max-w-full items-start gap-2 rounded-md bg-muted/30 px-3 py-1.5 typography-meta text-muted-foreground">
    <Icon name={icon} className="mt-0.5 size-3.5 shrink-0" />
    <div className="min-w-0 break-words">{children}</div>
  </div>
);

const ChatThinkingBody: React.FC<{
  content: ChatThinkingContent;
  messageId: string;
  streaming: boolean;
}> = ({ content, messageId, streaming }) => {
  if (content.redacted) return null;
  // Show received reasoning immediately. The Markdown renderer's paced reveal
  // can lag behind a busy stream and replay thinking after answer text starts.
  if (streaming) {
    return <div className="markdown-content markdown-reasoning whitespace-pre-wrap break-words">{content.thinking}</div>;
  }
  return <MarkdownRenderer content={content.thinking} messageId={messageId} variant="reasoning" />;
};

const ChatThinkingBlock: React.FC<{
  content: ChatThinkingContent; messageId: string; streaming: boolean; label: string;
}> = ({ content, messageId, streaming, label }) => {
  const visible = useUIStore(state => state.showReasoningTraces);
  const collapse = useUIStore(state => state.collapsibleThinkingBlocks);
  const [open, setOpen] = React.useState(streaming || !collapse);
  React.useEffect(() => { setOpen(streaming || !collapse); }, [streaming, collapse]);
  if (!visible || (!content.redacted && !content.thinking.trim())) return null;
  const preview = content.redacted ? '' : thinkingPreview(content.thinking);
  return <details className="group/thinking my-1" open={open && !content.redacted}
    onToggle={event => setOpen(event.currentTarget.open)} data-conversation-activity-kind="thinking">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl py-1.5 pr-2 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
      <Icon name="brain" className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-foreground/80">{label}{content.redacted ? ' (redacted)' : ''}</span>
      {!streaming && !open && preview ? <span className="min-w-0 flex-1 truncate opacity-75">{preview}</span> : <span className="flex-1" />}
      <Icon name="arrow-right-s" className="size-3.5 shrink-0 transition-transform group-open/thinking:rotate-90" />
    </summary>
    {!content.redacted ? <div className="ml-2 border-l border-border/60 py-1 pl-3 text-muted-foreground">
      <ChatThinkingBody content={content} messageId={messageId} streaming={streaming} />
    </div> : null}
  </details>;
};

const ChatToolSequence: React.FC<{
  calls: ChatToolCall[];
  cwd: string;
  generatingCallIds?: ReadonlySet<string>;
  executionById: Record<string, ChatToolExecutionState>;
  resultByCallId: ReadonlyMap<string, ChatToolResultMessage>;
}> = ({ calls, cwd, generatingCallIds, executionById, resultByCallId }) => {
  const projected = groupToolCalls(calls.map((call) => ({
    toolName: call.name,
    toolCallId: call.id,
    arguments: call.arguments,
    details: resultByCallId.get(call.id)?.details
      ?? executionById[call.id]?.result
      ?? executionById[call.id]?.partialResult,
  })));
  const byId = new Map(calls.map((call) => [call.id, call]));
  return <>{projected.map((group) => group.type === 'single' ? (
    <ChatToolCard
      key={group.entry.toolCallId}
      call={byId.get(group.entry.toolCallId)!}
      generating={generatingCallIds?.has(group.entry.toolCallId)}
      cwd={cwd}
      execution={executionById[group.entry.toolCallId]}
      executionById={executionById}
      result={resultByCallId.get(group.entry.toolCallId)}
    />
  ) : (
    <ChatReadOnlyToolGroup
      key={`group:${group.entries[0]!.toolCallId}`}
      calls={group.entries.map((entry) => byId.get(entry.toolCallId)!)}
      cwd={cwd}
      executionById={executionById}
      resultByCallId={resultByCallId}
    />
  ))}</>;
};

const AssistantMessage: React.FC<{
  cwd: string;
  entryId: string;
  executionById: Record<string, ChatToolExecutionState>;
  hiddenThinkingLabel?: string;
  message: ChatAssistantMessage;
  resultByCallId: ReadonlyMap<string, ChatToolResultMessage>;
  streaming?: boolean;
}> = ({ cwd, entryId, executionById, hiddenThinkingLabel, message, resultByCallId, streaming = false }) => {
  const preview = React.useContext(ConversationPreviewContext);
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < message.content.length;) {
    const content = message.content[index]!;
    if (content.type === 'toolCall') {
      const consecutive: ChatToolCall[] = [];
      while (index < message.content.length && message.content[index]?.type === 'toolCall') {
        consecutive.push(message.content[index] as ChatToolCall);
        index += 1;
      }
      rendered.push(
        <ChatToolSequence key={`tools:${consecutive[0]!.id}`} calls={consecutive}
          generatingCallIds={message.stopReason === 'pending' ? new Set(consecutive.map(call => call.id)) : undefined}
          cwd={cwd} executionById={executionById} resultByCallId={resultByCallId} />,
      );
      continue;
    }
      if (content.type === 'text') {
        rendered.push(
          <ChatTextSource key={`${entryId}:text:${index}`} entryId={entryId} text={content.text}
            offset={message.content.slice(0, index).filter((part) => part.type === 'text').reduce((total, part) => total + part.text.length + 1, 0)}>
            <MarkdownRenderer
              content={content.text}
              messageId={`${entryId}:text:${index}`}
              isStreaming={streaming}
              enableFileReferences={!preview}
            />
          </ChatTextSource>,
        );
        index += 1;
        continue;
      }
      if (content.type === 'thinking') {
        rendered.push(<ChatThinkingBlock key={`${entryId}:thinking:${index}`} content={content}
          messageId={`${entryId}:thinking:${index}`} label={hiddenThinkingLabel || 'Thinking'}
          streaming={streaming && message.stopReason === 'pending' && index === message.content.length - 1} />);
        index += 1;
        continue;
      }
    index += 1;
  }
  return <div className="max-w-full">
    {rendered}
    {message.errorMessage && message.stopReason !== 'aborted' && (
      <div className="mt-2 rounded-md bg-[var(--status-error)]/10 px-3 py-2 typography-meta text-[var(--status-error)]">
        {message.errorMessage}
      </div>
    )}
  </div>;
};

export const ChatSortedActivityGroup: React.FC<{
  cwd: string;
  executionById: Record<string, ChatToolExecutionState>;
  hiddenThinkingLabel: string;
  projection: ChatSortedTurnProjection;
  resultByCallId: ReadonlyMap<string, ChatToolResultMessage>;
  part?: 'header' | 'body';
  expanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
}> = ({ cwd, executionById, hiddenThinkingLabel, projection, resultByCallId, part, expanded: controlledExpanded, onExpandedChange }) => {
  const { t } = useI18n();
  const activityRenderMode = useUIStore((state) => state.activityRenderMode);
  const preview = React.useContext(ConversationPreviewContext);
  const showThinking = useUIStore(state => state.showReasoningTraces);
  const activity = projection.activity.filter(item => showThinking || item.kind !== 'thinking');
  const [localExpanded, setExpanded] = React.useState(activityRenderMode === 'summary');
  const expanded = controlledExpanded ?? localExpanded;
  React.useEffect(() => {
    setExpanded(activityRenderMode === 'summary');
  }, [activityRenderMode]);

  const running = activity.some((item) => (
    item.streaming
    || (item.kind === 'tool' && executionById[item.call.id]?.status === 'running')
  ));
  const failed = activity.some((item) => {
    if (item.kind !== 'tool') return false;
    const execution = executionById[item.call.id];
    const result = resultByCallId.get(item.call.id);
    if (item.call.name === 'code_retrieval') return ['failed', 'partial', 'invalid', 'unavailable'].includes(explorePresentation(execution, result, item.streaming).phase);
    return result?.isError || execution?.status === 'error'
      || (isFileChangeTool(item.call.name) && ['failed', 'partial'].includes(fileChangePhase(execution, result, item.streaming)));
  });
  const latest = activity.at(-1);
  const latestLabel = latest?.kind === 'tool'
    ? latest.call.name
    : latest?.kind === 'thinking'
      ? hiddenThinkingLabel
      : latest?.kind === 'justification'
        ? t('chat.reasoningTrace.justification')
        : '';

  if (!activity.length) return null;
  return (
    <section
      className="min-w-0"
      data-conversation-sorted-activity="true"
    >
      {part !== 'body' && <button
        type="button"
        onClick={() => onExpandedChange ? onExpandedChange(!expanded) : setExpanded(value => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left typography-meta text-muted-foreground hover:bg-interactive-hover"
        aria-expanded={expanded}
      >
        <Icon
          name={running ? 'loader-4' : failed ? 'error-warning' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            running && 'animate-spin',
            failed && 'text-[var(--status-error)]',
          )}
        />
        <span className="font-medium">{t('chat.activity.title')}</span>
        {latestLabel ? <span className="min-w-0 flex-1 truncate">· {latestLabel}</span> : <span className="flex-1" />}
        {failed ? <ChatToolStatus status="error" /> : null}
        <span className="typography-micro">{activity.length}</span>
        <Icon name="arrow-down-s" className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>}
      {part !== 'header' && expanded ? (
        <div className="ml-2 space-y-2 border-l border-border py-2 pl-3">
          {activity.map((item, index) => {
            if (item.kind === 'tool') {
              if (activity[index - 1]?.kind === 'tool') return null;
              const calls: ChatToolCall[] = [];
              const generatingCallIds = new Set<string>();
              for (let next = index; next < activity.length; next += 1) {
                const candidate = activity[next]!;
                if (candidate.kind !== 'tool') break;
                calls.push(candidate.call);
                if (candidate.streaming) generatingCallIds.add(candidate.call.id);
              }
              return <ChatToolSequence key={item.id} calls={calls} cwd={cwd}
                generatingCallIds={generatingCallIds}
                executionById={executionById} resultByCallId={resultByCallId} />;
            }
            return (
              <React.Fragment key={item.id}>
                {item.kind === 'thinking' ? (
                  <ChatThinkingBlock content={item.content} messageId={item.id}
                    streaming={item.streaming} label={hiddenThinkingLabel} />
                ) : (
                  <div className="rounded-lg bg-background/45 px-2.5 py-2" data-conversation-activity-kind="justification">
                    <div className="mb-1 flex items-center gap-1.5 typography-meta font-medium text-muted-foreground">
                      <Icon name="chat-1" className="size-3.5" />
                      {t('chat.reasoningTrace.justification')}
                    </div>
                    <ChatTextSource entryId={item.sourceId} text={item.content.text} offset={0}
                      contentIndex={Number(item.id.slice(item.id.lastIndexOf(':') + 1))}>
                      <MarkdownRenderer
                        content={item.content.text}
                        messageId={item.id}
                        isStreaming={item.streaming}
                        variant="assistant"
                        enableFileReferences={!preview}
                      />
                    </ChatTextSource>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};

export const ChatTurnUserMessage: React.FC<{
  cwd: string;
  entry?: ChatSessionMessageEntry;
  forkBusyEntryId?: string | null;
  message: ChatUserMessage;
  onFork?(entry: ChatSessionMessageEntry): void;
  onOpenThread?(entry: ChatSessionMessageEntry, options: { carryBlocks: boolean }): void;
  onRecover?(entry: ChatSessionMessageEntry): void;
  recoveryBusyEntryId?: string | null;
  status?: ChatSessionSubmissionStatus;
  threadBusyEntryId?: string | null;
}> = ({
  entry,
  forkBusyEntryId,
  message,
  onFork,
  onOpenThread,
  onRecover,
  recoveryBusyEntryId,
  status,
  threadBusyEntryId,
}) => {
  const { t } = useI18n();
  const plain = useUIStore(state => state.userMessageRenderingMode === 'plain');
  const messageId = entry?.id ?? `live-user:${message.timestamp}`;
  const messageText = chatContentText(message.content).trim();
  const copyMessage = React.useCallback(() => {
    if (!messageText) return;
    void copyTextToClipboard(messageText).then((result) => {
      if (result.ok) toast.success(t('sessions.sidebar.session.menu.copied'));
      else toast.error(result.error);
    });
  }, [messageText, t]);
  return (
    <article id={entry ? `conversation-entry-${entry.id}` : undefined} data-conversation-user-message data-conversation-message-role="user" data-conversation-entry-id={entry?.id} className="group/message ml-auto max-w-[85%]">
      <div className="rounded-xl bg-[var(--chat-user-message-bg)] px-4 py-3 text-[var(--chat-user-message)]">
        <ChatCollapsibleUserContent><ChatUserContentView content={message.content} messageId={messageId} plain={plain} /></ChatCollapsibleUserContent>
      </div>
      {status ? (
        <div
          className={cn(
            'mt-1 flex items-center justify-end gap-1.5 px-1 typography-micro text-muted-foreground',
            status === 'failed' && 'text-[var(--status-error)]',
            status === 'uncertain' && 'text-[var(--status-warning)]',
          )}
          data-conversation-submission-status={status}
        >
          <Icon
            name={status === 'preparing' || status === 'dispatching'
              ? 'loader-4'
              : status === 'accepted'
                ? 'check'
                : 'error-warning'}
            className={cn(
              'size-3',
              (status === 'preparing' || status === 'dispatching') && 'animate-spin',
            )}
          />
          {t(`chat.submission.${status}`)}
        </div>
      ) : null}
      {messageText || (entry && (onFork || onOpenThread || onRecover)) ? (
        <div className={cn(
          'mt-1 flex h-6 items-center justify-end transition-opacity',
          'opacity-100',
        )}>
          {messageText ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={copyMessage}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  aria-label={t('chat.messageBody.actions.copyMessageAria')}
                >
                  <Icon name="file-copy" className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
            </Tooltip>
          ) : null}
          {entry && messageText && onOpenThread ? (
            <OpenThreadButton
              busy={threadBusyEntryId === entry.id}
              disabled={threadBusyEntryId !== null && threadBusyEntryId !== undefined}
              entry={entry}
              onOpen={onOpenThread}
            />
          ) : null}
          {entry && onFork ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onFork(entry)}
                  disabled={forkBusyEntryId !== null && forkBusyEntryId !== undefined}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
                  aria-label={t('chat.messageBody.actions.forkAria')}
                >
                  <Icon
                    name={forkBusyEntryId === entry.id ? 'loader-4' : 'git-branch'}
                    className={cn('size-3.5', forkBusyEntryId === entry.id && 'animate-spin')}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('chat.messageBody.actions.fork')}</TooltipContent>
            </Tooltip>
          ) : null}
          {entry && onRecover ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onRecover(entry)}
                  disabled={recoveryBusyEntryId !== null && recoveryBusyEntryId !== undefined}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
                  aria-label={t('chat.messageBody.actions.revertAria')}
                >
                  <Icon
                    name={recoveryBusyEntryId === entry.id ? 'loader-4' : 'history'}
                    className={cn('size-3.5', recoveryBusyEntryId === entry.id && 'animate-spin')}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('chat.messageBody.actions.revert')}</TooltipContent>
            </Tooltip>
          ) : null}
          <ChatMoreButton />
        </div>
      ) : null}
      <EntryExtras itemId={entry?.id} />
    </article>
  );
};

export const ChatTimelineEntryList: React.FC<Omit<
  ChatTimelineProps,
  'assistantWaiting' | 'liveUser' | 'liveUserStatus'
> & {
  outputDurationsMs?: Readonly<Record<string, number>>;
  projectedResultByCallId?: ReadonlyMap<string, ChatToolResultMessage>;
  part?: 'body' | 'footer';
  /** A physical body row uses its logical Run's sorted projection. Activity
   * has its own virtual rows; it must not be mounted again inside the body. */
  sortedPresentation?: ChatSortedTurnProjection;
  extensionPresentation?: ReadonlyMap<string, () => React.ReactNode>;
}> = ({
  cwd,
  entries,
  forkBusyEntryId,
  hiddenThinkingLabel,
  liveAssistant,
  onFork,
  onOpenThread,
  onRecover,
  outputDurationsMs,
  projectedResultByCallId,
  recoveryBusyEntryId,
  sessionId,
  threadBusyEntryId,
  toolExecutions,
  part,
  sortedPresentation,
  extensionPresentation,
}) => {
  const { t } = useI18n();
  const chatRenderMode = useUIStore((state) => state.chatRenderMode);
  const preview = React.useContext(ConversationPreviewContext);
  const messageRenderers = useWorkbenchMatchRenderers<{
    cwd: string;
    entry: ChatSessionEntry;
    sessionId: string;
  }>('message-renderer', 'chat.timeline.entries', !preview && !extensionPresentation);
  const previousProjection = React.useRef<ReturnType<typeof projectChatTimeline> | undefined>(undefined);
  const projection = React.useMemo(
    () => projectChatTimeline(entries, liveAssistant, undefined, previousProjection.current),
    [entries, liveAssistant],
  );
  previousProjection.current = projection;
  const resultByCallId = projectedResultByCallId ?? projection.resultByCallId;
  const extensionEntries = React.useMemo(() => {
    const renderedById = new Map<string, React.ReactNode>();
    if (extensionPresentation) {
      for (const entry of projection.visibleEntries) {
        const render = extensionPresentation.get(entry.id);
        if (render) renderedById.set(entry.id, part === 'footer' ? null : render());
      }
      return renderedById;
    }
    if (preview) return renderedById;
    for (const entry of projection.visibleEntries) {
      const rendered = renderFirstWorkbenchMatch(messageRenderers, { cwd, entry, sessionId });
      if (rendered !== undefined) renderedById.set(entry.id, rendered);
    }
    return renderedById;
  }, [cwd, messageRenderers, preview, projection.visibleEntries, sessionId, extensionPresentation, part]);
  const builtInEntries = React.useMemo(
    () => projection.visibleEntries.filter((entry) => !extensionEntries.has(entry.id)),
    [extensionEntries, projection.visibleEntries],
  );
  const sortedProjection = React.useMemo(
    () => sortedPresentation ?? (chatRenderMode === 'sorted'
      ? projectChatSortedTurn(builtInEntries, projection.liveAssistant)
      : undefined),
    [builtInEntries, chatRenderMode, projection.liveAssistant, sortedPresentation],
  );
  const resolvedThinkingLabel = hiddenThinkingLabel || t('chat.reasoningTrace.thinking');
  // The row owns the whole turn, independent of live/sorted presentation.
  // Only assistant prose belongs in copy/memory; thinking and tool output do
  // not. Native discussion/fork actions still need a persisted text message.
  const turnText = assistantMessagesForTurn(builtInEntries, projection.liveAssistant)
    .map((message) => message.content.filter((content) => content.type === 'text')
      .map((content) => content.text).join('\n').trim())
    .filter(Boolean).join('\n\n');
  const actionEntry = builtInEntries.filter((entry): entry is ChatSessionMessageEntry => (
    entry.type === 'message' && entry.message.role === 'assistant'
      && entry.message.content.some((content) => content.type === 'text' && content.text.trim())
  )).at(-1);
  const lastEntry = projection.visibleEntries.at(-1);
  const footerUsage = lastEntry?.type === 'run_usage' ? lastEntry : undefined;

  return (
    <ChatToolDisclosureScope key={sessionId} sessionId={sessionId}>
    <div className="flex flex-col gap-3">
        {part !== 'footer' && projection.visibleEntries.map((entry) => {
          if (extensionEntries.has(entry.id)) {
            return <React.Fragment key={entry.id}>{extensionEntries.get(entry.id)}</React.Fragment>;
          }
          if (entry.type === 'message') {
            const { message } = entry;
            if (message.role === 'user') {
              return (
                <ChatTurnUserMessage
                  key={entry.id}
                  cwd={cwd}
                  entry={entry}
                  forkBusyEntryId={forkBusyEntryId}
                  message={message}
                  onFork={onFork}
                  onOpenThread={onOpenThread}
                  onRecover={onRecover}
                  recoveryBusyEntryId={recoveryBusyEntryId}
                  threadBusyEntryId={threadBusyEntryId}
                />
              );
            }
            if (message.role === 'assistant') {
              const displayedMessage = chatRenderMode === 'sorted'
                ? sortedProjection?.answersBySourceId.get(entry.id)
                : message;
              const showsActivity = !sortedPresentation && sortedProjection?.activityAnchorId === entry.id
                && sortedProjection.activity.length > 0;
              if (!displayedMessage && !showsActivity) return null;
              return (
                <article id={`conversation-entry-${entry.id}`} data-conversation-entry-id={entry.id} data-conversation-message-role="assistant" key={entry.id} className="group/message w-full space-y-3">
                  {showsActivity && sortedProjection ? (
                    <ChatSortedActivityGroup
                      cwd={cwd}
                      executionById={toolExecutions}
                      hiddenThinkingLabel={resolvedThinkingLabel}
                      projection={sortedProjection}
                      resultByCallId={resultByCallId}
                    />
                  ) : null}
                  {displayedMessage ? (
                    <AssistantMessage
                      cwd={cwd}
                      entryId={entry.id}
                      executionById={toolExecutions}
                      hiddenThinkingLabel={resolvedThinkingLabel}
                      message={displayedMessage}
                      resultByCallId={resultByCallId}
                    />
                  ) : null}
                  <EntryExtras itemId={entry.id} />
                </article>
              );
            }
            if (message.role === 'toolResult') {
              return (
                <article key={entry.id} className="w-full rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
                  <div className="mb-2 flex items-center gap-2 typography-ui-label text-foreground">
                    <Icon name={message.isError ? 'error-warning' : 'check'} className="size-3.5" />
                    <span className="font-mono">{message.toolName}</span>
                    <span className="flex-1" />
                  </div>
                  <ToolResultContent messageId={entry.id} result={message} />
                </article>
              );
            }
            if (message.role === 'system') return null;
            if (message.role === 'bashExecution') {
              const renderedOutput = renderTerminalOutput(message.output);
              return (
                <article key={entry.id} className="w-full rounded-lg border border-border/60 bg-muted/15">
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 typography-ui-label text-foreground">
                    <Icon name="terminal" className="size-3.5" />
                    <code className="min-w-0 flex-1 break-all">{message.command}</code>
                    {message.cancelled ? <span>cancelled</span> : message.exitCode !== undefined ? <span>exit {message.exitCode}</span> : null}
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono typography-meta text-foreground">{renderedOutput}</pre>
                  {message.truncated && (
                    <p className="border-t border-border/60 px-3 py-1.5 typography-micro text-[var(--status-warning)]">
                      Output was truncated; the complete output path is shown below when available.
                    </p>
                  )}
                  {message.fullOutputPath && (
                    <p className="border-t border-border/60 px-3 py-1.5 break-all font-mono typography-micro text-muted-foreground">
                      {message.fullOutputPath}
                    </p>
                  )}
                </article>
              );
            }
            if (message.role === 'custom') {
              if (message.customType === 'media') return <article key={entry.id}><EntryExtras itemId={entry.id} /></article>;
              if (message.customType === 'thread-message') {
                const details = message.details && typeof message.details === 'object' && !Array.isArray(message.details) ? message.details as Record<string, unknown> : {};
                return <ChatReceivedThreadMessage key={entry.id} entryId={entry.id} sessionId={sessionId}
                  id={typeof details.messageId === 'string' ? details.messageId : undefined} content={chatContentText(message.content)} />;
              }
              return (
                <MetaEntry key={entry.id} icon="plug-2">
                  <strong>{message.customType}</strong><EntryExtras itemId={entry.id} />
                  <ChatUserContentView content={message.content} messageId={entry.id} />
                  {message.details !== undefined && <RawJsonDetails value={message.details} />}
                </MetaEntry>
              );
            }
            if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
              return (
                <article key={entry.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <div className="mb-1 flex items-center gap-2 typography-meta font-medium text-muted-foreground">
                    <Icon name="contract-up-down" className="size-3.5" />
                    {message.role === 'branchSummary' ? 'Branch summary' : `Compaction · ${message.tokensBefore} tokens`}
                  </div>
                  <MarkdownRenderer content={message.summary} messageId={entry.id} />
                </article>
              );
            }
            return (
              <MetaEntry key={entry.id} icon="error-warning">
                <strong>{message.originalRole}</strong>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono typography-micro">{jsonText(message.data)}</pre>
              </MetaEntry>
            );
          }

          if (entry.type === 'custom_message') {
            if (entry.customType === 'thread-message') {
              const details = entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details) ? entry.details as Record<string, unknown> : {};
              return <ChatReceivedThreadMessage key={entry.id} entryId={entry.id} sessionId={sessionId}
                id={typeof details.messageId === 'string' ? details.messageId : undefined} content={chatContentText(entry.content)} />;
            }
            return (
              <MetaEntry key={entry.id} icon="plug-2">
                <strong>{entry.customType}</strong>
                <ChatUserContentView content={entry.content} messageId={entry.id} />
                {entry.details !== undefined && <RawJsonDetails value={entry.details} />}
              </MetaEntry>
            );
          }
          if (entry.type === 'compaction' || entry.type === 'branch_summary') {
            return (
              <article key={entry.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 typography-meta font-medium text-muted-foreground">
                  <Icon name="contract-up-down" className="size-3.5" />
                  {entry.type === 'compaction' ? `Compaction · ${entry.tokensBefore} tokens` : 'Branch summary'}

                </div>
                <MarkdownRenderer content={entry.summary} messageId={entry.id} />
              </article>
            );
          }
          if (entry.type === 'label') {
            return <MetaEntry key={entry.id} icon="target">{entry.label ?? 'Label'} → {entry.targetId}</MetaEntry>;
          }
          if (entry.type === 'context_edit') {
            return <MetaEntry key={entry.id} icon="file-edit">Model context {entry.replacement === null ? 'omitted' : 'edited'} · {entry.targetId}</MetaEntry>;
          }
          if (entry.type === 'usage') {
            return <MetaEntry key={entry.id} icon="pie-chart">{entry.kind} · {entry.provider}/{entry.model} · <ChatAssistantUsageFooter usage={entry.usage} /></MetaEntry>;
          }
          if (entry.type === 'run_usage') {
            return entry === footerUsage ? null : <ChatTurnUsageFooter key={entry.id} usages={entry.usages} />;
          }
          if (entry.type === 'custom') {
            return (
              <details key={entry.id} className="mx-auto max-w-full rounded-md bg-muted/30 px-3 py-1.5 typography-meta text-muted-foreground">
                <summary className="cursor-pointer select-none">Extension state · {entry.customType}</summary>
                {entry.data !== undefined && (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono typography-micro text-foreground">{jsonText(entry.data)}</pre>
                )}
              </details>
            );
          }
          return (
            <MetaEntry key={entry.id} icon="error-warning">
              <strong>{entry.originalType}</strong>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono typography-micro">{jsonText(entry.data)}</pre>
            </MetaEntry>
          );
        })}

        {part !== 'footer' && projection.liveAssistant && (() => {
          const displayedMessage = chatRenderMode === 'sorted'
            ? sortedProjection?.answersBySourceId.get(CHAT_SORTED_LIVE_ASSISTANT_ID)
            : projection.liveAssistant;
          const showsActivity = !sortedPresentation && sortedProjection?.activityAnchorId === CHAT_SORTED_LIVE_ASSISTANT_ID
            && sortedProjection.activity.length > 0;
          if (!displayedMessage && !showsActivity) return null;
          return (
            <article className="w-full space-y-3" aria-live="polite" data-conversation-entry-id={CHAT_SORTED_LIVE_ASSISTANT_ID} data-conversation-message-role="assistant">
              {showsActivity && sortedProjection ? (
                <ChatSortedActivityGroup
                  cwd={cwd}
                  executionById={toolExecutions}
                  hiddenThinkingLabel={resolvedThinkingLabel}
                  projection={sortedProjection}
                  resultByCallId={resultByCallId}
                />
              ) : null}
              {displayedMessage ? (
                <AssistantMessage
                  cwd={cwd}
                  entryId={`live:${sessionId}`}
                  executionById={toolExecutions}
                  hiddenThinkingLabel={resolvedThinkingLabel}
                  message={displayedMessage}
                  resultByCallId={resultByCallId}
                  streaming={displayedMessage.stopReason === 'pending'}
                />
              ) : null}
            </article>
          );
        })()}
        {part !== 'body' && <><ChatTurnChangedFiles messages={assistantMessagesForTurn(builtInEntries, projection.liveAssistant)}
          results={resultByCallId} executions={toolExecutions} cwd={cwd} sessionId={sessionId} />
        <ChatTurnUsageFooter
          entries={entries}
          usages={footerUsage?.usages}
          liveAssistant={projection.liveAssistant}
          outputDurationsMs={outputDurationsMs}
          actions={turnText ? (
            <div className="flex h-6 shrink-0 items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      void copyTextToClipboard(turnText).then((result) => {
                        if (result.ok) toast.success(t('sessions.sidebar.session.menu.copied'));
                        else toast.error(result.error);
                      });
                    }}
                    className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    aria-label={t('chat.messageBody.actions.copyAnswer')}
                  >
                    <Icon name="file-copy" className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
              </Tooltip>
              {actionEntry && onOpenThread ? (
                <OpenThreadButton
                  busy={threadBusyEntryId === actionEntry.id}
                  disabled={threadBusyEntryId !== null && threadBusyEntryId !== undefined}
                  entry={actionEntry}
                  onOpen={onOpenThread}
                />
              ) : null}
              {actionEntry && onFork ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onFork(actionEntry)}
                      disabled={forkBusyEntryId !== null && forkBusyEntryId !== undefined}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
                      aria-label={t('chat.messageBody.actions.forkAria')}
                    >
                      <Icon
                        name={forkBusyEntryId === actionEntry.id ? 'loader-4' : 'git-branch'}
                        className={cn('size-3.5', forkBusyEntryId === actionEntry.id && 'animate-spin')}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('chat.messageBody.actions.fork')}</TooltipContent>
                </Tooltip>
              ) : null}
              <ChatMoreButton />
            </div>
          ) : undefined}
        /></>}
    </div>
    </ChatToolDisclosureScope>
  );
};
