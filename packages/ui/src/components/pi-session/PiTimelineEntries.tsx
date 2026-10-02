import React from 'react';
import type {
  JsonValue,
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionMessageEntry,
  PiThinkingContent,
  PiToolCall,
  PiToolResultMessage,
  PiUserContent,
  PiUserMessage,
} from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { renderTerminalOutput } from '@/components/chat/message/parts/toolOutput';
import { getApplyPatchFileEntries } from '@/components/chat/message/parts/toolDiffUtils';
import { getToolSummary, groupToolCalls } from '@/components/chat/message/parts/toolSummary';
import { harnessShellIdFromDetails, openHarnessTerminal } from '@/lib/openHarnessTerminal';
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
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { PatchHunkReview } from '@/components/workbench/PatchHunkReview';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import type {
  PiSessionSubmissionStatus,
  PiToolExecutionState,
} from '@/stores/usePiSessionStore';
import { PiExtensionStatusCard } from './PiExtensionStatusCard';
import {
  renderFirstWorkbenchMatch,
  useWorkbenchMatchRenderers,
} from '@/lib/extensions/workbench-registry';
import {
  parseExtensionStatus,
  parseSubagentNotifications,
  parseSubagentRun,
  projectToolCalls,
  piContentText,
  type SubagentNotificationPresentation,
  type SubagentRunPresentation,
  type SubagentStatus,
  type ToolCallPresentation,
} from './extensionPresentation';
import {
  projectPiTimeline,
} from './piTimelineProjection';
import type { PiAssistantWaitingPresentation } from './piAssistantWaiting';
import {
  PI_SORTED_LIVE_ASSISTANT_ID,
  projectPiSortedTurn,
  type PiSortedTurnProjection,
} from './piSortedTurnProjection';
import { ChatMoreButton, ChatTextSource } from './ChatContextMenu';
import { PiFileChangePreview, PiFileChangePreviewScope } from './PiFileChangePreview';
import { fileChangePhase, isFileChangeTool, projectFileChanges } from './fileChangePreview';
import { PiExploreCard, PiExploreScope } from './PiExploreCard';
import { explorePresentation } from './explorePresentation';
import { HarnessThreadMarkers } from './HarnessThreadMarkers';
import { PiTurnUsageFooter } from './PiTurnUsageFooter';
import { assistantMessagesForTurn } from '@/lib/pi-runtime/usagePresentation';
import { parseCompactionTraceDetails, PI_COMPACTION_TRACE_OPEN_EVENT } from '@/lib/pi-runtime/compactionTrace';

export interface PiTimelineProps {
  compactionStatus?: 'requested' | 'running' | 'retrying' | 'ready' | 'applying' | 'failed';
  assistantWaiting?: PiAssistantWaitingPresentation;
  cwd: string;
  entries: PiSessionEntry[];
  forkBusyEntryId?: string | null;
  hiddenThinkingLabel?: string;
  leafId?: string | null;
  liveAssistant?: PiAssistantMessage;
  liveUser?: PiUserMessage;
  liveUserStatus?: PiSessionSubmissionStatus;
  onFork?(entry: PiSessionMessageEntry): void;
  onOpenCompaction?(): void;
  onApplyCompaction?(): void;
  onOpenThread?(entry: PiSessionMessageEntry, options: { carryBlocks: boolean }): void;
  onRecover?(entry: PiSessionMessageEntry): void;
  onScrollContainerChange?(element: HTMLElement | null): void;
  rightSafeInset?: boolean;
  recoveryBusyEntryId?: string | null;
  sessionId: string;
  threadBusyEntryId?: string | null;
  toolExecutions: Record<string, PiToolExecutionState>;
}

const imageUrl = (content: Extract<PiUserContent, { type: 'image' }>): string => (
  `data:${content.mimeType};base64,${content.data}`
);

const jsonText = (value: JsonValue): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

const formatCount = (value: number): string => new Intl.NumberFormat().format(value);
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

const formatToolEnd = (endMs: number): string => (
  endMs > 100_000_000_000
    ? new Date(endMs).toLocaleTimeString()
    : `${formatDuration(endMs)} elapsed`
);

const thinkingPreview = (value: string): string => {
  const normalized = value
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 79).trimEnd()}…`;
};

const PiUserContentView: React.FC<{
  content: string | PiUserContent[];
  messageId: string;
  variant?: 'assistant' | 'tool';
}> = ({ content, messageId, variant = 'assistant' }) => {
  const parts: PiUserContent[] = typeof content === 'string'
    ? [{ text: content, type: 'text' }]
    : content;
  return (
    <>
      {parts.map((part, index) => (
        part.type === 'text' ? (
          <ChatTextSource key={`${messageId}:text:${index}`} entryId={messageId} text={part.text}
            offset={parts.slice(0, index).filter((part) => part.type === 'text').reduce((total, part) => total + part.text.length + 1, 0)}>
            <MarkdownRenderer
              content={part.text}
              messageId={`${messageId}:text:${index}`}
              variant={variant}
              enableFileReferences
            />
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
  entry: PiSessionMessageEntry;
  onOpen(entry: PiSessionMessageEntry, options: { carryBlocks: boolean }): void;
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

const statusIcon = (status: SubagentStatus): React.ComponentProps<typeof Icon>['name'] => {
  if (status === 'running') return 'loader-4';
  if (status === 'completed') return 'check';
  if (status === 'failed' || status === 'stopped') return 'error-warning';
  if (status === 'paused') return 'pause';
  if (status === 'detached') return 'share-2';
  return 'time';
};

const statusClass = (status: SubagentStatus): string => {
  if (status === 'running') return 'text-primary';
  if (status === 'completed') return 'text-[var(--status-success)]';
  if (status === 'failed' || status === 'stopped') return 'text-[var(--status-error)]';
  if (status === 'paused' || status === 'detached') return 'text-[var(--status-warning)]';
  return 'text-muted-foreground';
};

const SubagentRunView: React.FC<{
  messageId: string;
  presentation: SubagentRunPresentation;
}> = ({ messageId, presentation }) => (
  <div className="space-y-2 rounded-lg border border-border/60 bg-background/35 p-2.5">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
      <span className="font-medium text-foreground">Agent Task</span>
      <span>{presentation.mode}</span>
      <span>{presentation.agents.length} {presentation.agents.length === 1 ? 'agent' : 'agents'}</span>
      {presentation.toolCount !== undefined && <span>{formatCount(presentation.toolCount)} tools</span>}
      {presentation.tokens !== undefined && <span>{formatCount(presentation.tokens)} tokens</span>}
      {presentation.durationMs !== undefined && <span>{formatDuration(presentation.durationMs)}</span>}
      {presentation.runId && <code className="break-all typography-micro">{presentation.runId}</code>}
    </div>
    <div className="space-y-2">
      {presentation.agents.map((agent) => (
        <details
          key={`${agent.index}:${agent.agent}`}
          className="group/agent rounded-md border border-border/60 bg-muted/15"
          open={agent.status === 'running' || agent.status === 'failed'}
        >
          <summary className="flex cursor-pointer list-none items-start gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
            <Icon
              name={statusIcon(agent.status)}
              className={cn('mt-0.5 size-3.5 shrink-0', statusClass(agent.status), agent.status === 'running' && 'animate-spin')}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono typography-ui-label text-foreground">{agent.agent}</span>
                <span className={cn('typography-micro', statusClass(agent.status))}>{agent.status}</span>
                {agent.model && <span className="typography-micro text-muted-foreground">{agent.model}{agent.thinking ? ` · ${agent.thinking}` : ''}</span>}
              </div>
              {agent.task && <p className="mt-0.5 break-words typography-meta text-muted-foreground">{agent.task}</p>}
            </div>
            <Icon name="arrow-down-s" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/agent:rotate-180" />
          </summary>
          <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1 typography-micro text-muted-foreground">
              {agent.toolCount !== undefined && <span>{formatCount(agent.toolCount)} tools</span>}
              {agent.turnCount !== undefined && <span>{formatCount(agent.turnCount)} turns</span>}
              {agent.tokens !== undefined && <span>{formatCount(agent.tokens)} tokens</span>}
              {agent.inputTokens !== undefined && <span>{formatCount(agent.inputTokens)} in</span>}
              {agent.outputTokens !== undefined && <span>{formatCount(agent.outputTokens)} out</span>}
              {agent.durationMs !== undefined && <span>{formatDuration(agent.durationMs)}</span>}
            </div>
            {agent.currentTool && (
              <div className="rounded-md bg-interactive-hover px-2 py-1.5 typography-meta text-foreground">
                <span className="text-muted-foreground">Current tool · </span>
                <code>{agent.currentTool}</code>
                {agent.currentToolArgs && <pre className="mt-1 whitespace-pre-wrap break-words font-mono typography-micro">{agent.currentToolArgs}</pre>}
              </div>
            )}
            {agent.currentPath && <p className="break-all font-mono typography-micro text-muted-foreground">{agent.currentPath}</p>}
            {agent.skills.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {agent.skills.map((skill) => <code key={skill} className="rounded bg-muted px-1.5 py-0.5 typography-micro">{skill}</code>)}
              </div>
            )}
            {agent.recentTools.length > 0 && (
              <details>
                <summary className="cursor-pointer typography-micro text-muted-foreground">Recent tools ({agent.recentTools.length})</summary>
                <div className="mt-1 space-y-1">
                  {agent.recentTools.map((tool, index) => (
                    <div key={`${tool.tool}:${index}`} className="rounded bg-background/70 px-2 py-1 font-mono typography-micro">
                      <span>{tool.tool}</span>
                      {tool.endMs !== undefined && <span className="ml-2 text-muted-foreground">{formatToolEnd(tool.endMs)}</span>}
                      {tool.args && <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{tool.args}</pre>}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {agent.recentOutput.length > 0 && (
              <details open={agent.status === 'running'}>
                <summary className="cursor-pointer typography-micro text-muted-foreground">Recent output</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background/70 p-2 font-mono typography-micro text-foreground">{agent.recentOutput.join('\n')}</pre>
              </details>
            )}
            {agent.finalOutput && (
              <div className="rounded-md bg-background/70 px-2 py-1.5">
                <MarkdownRenderer content={agent.finalOutput} messageId={`${messageId}:subagent:${agent.index}:output`} variant="tool" enableFileReferences />
              </div>
            )}
            {agent.error && <pre className="whitespace-pre-wrap break-words rounded-md bg-[var(--status-error)]/10 p-2 font-mono typography-micro text-[var(--status-error)]">{agent.error}</pre>}
            {agent.sessionFile && <p className="break-all font-mono typography-micro text-muted-foreground">Session · {agent.sessionFile}</p>}
          </div>
        </details>
      ))}
    </div>
    <RawJsonDetails value={presentation.raw} />
  </div>
);

const SubagentNotificationsView: React.FC<{
  content: string | PiUserContent[];
  details?: JsonValue;
  messageId: string;
  notifications: SubagentNotificationPresentation[];
}> = ({ content, details, messageId, notifications }) => (
  <article className="w-full space-y-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
    <div className="flex items-center gap-2 typography-ui-label text-foreground">
      <Icon name="ai-agent" className="size-3.5" />
      <span>Background Agent Task</span>
      {notifications.length > 1 && <span className="typography-micro text-muted-foreground">{notifications.length} completed</span>}
    </div>
    {notifications.map((notification, index) => (
      <div key={`${notification.agent}:${index}`} className="rounded-md border border-border/50 bg-background/45 px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name={statusIcon(notification.status)} className={cn('size-3.5', statusClass(notification.status))} />
          <span className="font-mono typography-ui-label text-foreground">{notification.agent}</span>
          {notification.taskInfo && <span className="typography-micro text-muted-foreground">{notification.taskInfo}</span>}
          <span className={cn('typography-micro', statusClass(notification.status))}>{notification.status}</span>
          {notification.durationMs !== undefined && <span className="typography-micro text-muted-foreground">{formatDuration(notification.durationMs)}</span>}
        </div>
        <div className="mt-1.5">
          <MarkdownRenderer content={notification.resultPreview} messageId={`${messageId}:notification:${index}`} variant="tool" enableFileReferences />
        </div>
        {notification.handoffPath && <p className="mt-1 break-all font-mono typography-micro text-muted-foreground">Handoff · {notification.handoffPath}</p>}
        {notification.sessionValue && <p className="mt-1 break-all font-mono typography-micro text-muted-foreground">{notification.sessionLabel ?? 'Session'} · {notification.sessionValue}</p>}
      </div>
    ))}
    <details>
      <summary className="cursor-pointer typography-micro text-muted-foreground">raw message</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">{piContentText(content)}</pre>
      {details !== undefined && <div className="mt-2"><RawJsonDetails value={details} /></div>}
    </details>
  </article>
);

const ToolCallRow: React.FC<{ call: ToolCallPresentation }> = ({ call }) => (
  <div>
    <span className="font-mono">{call.name}</span>{call.model ? <span> · {call.model}</span> : null} · {call.status}{call.durationMs === undefined ? '' : ` · ${formatDuration(call.durationMs)}`}{call.cost === undefined ? '' : ` · ${formatUsd(call.cost)}`}
    {call.error ? <p className="break-words text-[var(--status-error)]">{call.error}</p> : null}
  </div>
);

const ToolResultContent: React.FC<{
  messageId: string;
  result: PiToolResultMessage;
}> = ({ messageId, result }) => {
  const { t } = useI18n();
  const calls = projectToolCalls(result);
  const subagentRun = (result.toolName === 'subagent' || result.toolName === 'subagent_wait') && result.details !== undefined
    ? parseSubagentRun(result.details)
    : undefined;
  return (
    <div className="space-y-2">
      <PiUserContentView content={result.content} messageId={messageId} variant="tool" />
      {result.usage && (result.usage.totalTokens > 0 || result.usage.cost.total > 0) ? <p className="typography-meta text-muted-foreground">
        {result.usage.totalTokens > 0 ? `${formatCount(result.usage.totalTokens)} tokens · ` : ''}{formatUsd(result.usage.cost.total)}
      </p> : null}
      {calls ? <details className="typography-meta text-muted-foreground">
        <summary className="cursor-pointer">{t('chat.timeline.tools.callCount', { count: calls.calls.length })}{calls.complete ? '' : ` · ${t('chat.timeline.tools.incompleteRecord')}`}</summary>
        <div className="mt-2 space-y-1 border-l border-border/60 pl-3">
          {calls.calls.map(call => <ToolCallRow key={call.id} call={call} />)}
        </div>
      </details> : null}
      {subagentRun ? (
        <SubagentRunView messageId={messageId} presentation={subagentRun} />
      ) : result.details !== undefined ? (
        <RawJsonDetails label="details" value={result.details} />
      ) : null}
    </div>
  );
};

// A tool keeps its disclosure choice when a live message becomes a persisted
// entry, or when an adjacent read makes it part of a group. This cache belongs
// to the mounted turn, never to execution state or the native session history.
const ToolDisclosureContext = React.createContext<Map<string, boolean> | null>(null);

const PiToolDisclosureScope: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [choices] = React.useState(() => new Map<string, boolean>());
  return <ToolDisclosureContext.Provider value={choices}>
    <PiExploreScope><PiFileChangePreviewScope>{children}</PiFileChangePreviewScope></PiExploreScope>
  </ToolDisclosureContext.Provider>;
};

const PiToolDisclosure: React.FC<{
  children: React.ReactNode;
  className: string;
  disclosureId: string;
  initiallyExpanded?: boolean;
}> = ({ children, className, disclosureId, initiallyExpanded = false }) => {
  const choices = React.useContext(ToolDisclosureContext);
  const [expanded, setExpanded] = React.useState(() => choices?.get(disclosureId) ?? initiallyExpanded);
  return (
    <details className={className} open={expanded} data-pi-tool-disclosure={disclosureId}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        choices?.set(disclosureId, open);
        setExpanded(open);
      }}>
      {children}
    </details>
  );
};

const PiToolStatus: React.FC<{ status: PiToolExecutionState['status'] }> = ({ status }) => {
  const { t } = useI18n();
  return <span className={cn('shrink-0 typography-micro', status === 'success' && 'sr-only', status === 'error' && 'text-[var(--status-error)]')}>
    {t(`chat.timeline.tools.${status}`)}
  </span>;
};

const PiToolCard: React.FC<{
  call: PiToolCall;
  cwd: string;
  generating?: boolean;
  execution?: PiToolExecutionState;
  executionById?: Record<string, PiToolExecutionState>;
  result?: PiToolResultMessage;
}> = ({ call, cwd, generating = false, execution, executionById, result }) => {
  const { t } = useI18n();
  const toolRenderers = useWorkbenchMatchRenderers<{
    call: PiToolCall;
    cwd: string;
    execution?: PiToolExecutionState;
    result?: PiToolResultMessage;
  }>('tool-renderer', 'chat.timeline.tools');
  const workspaceId = useWorkbenchWorkspaceId();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const extensionRendered = renderFirstWorkbenchMatch(toolRenderers, { call, cwd, execution, result });
  const fileChanges = React.useMemo(() => extensionRendered === undefined ? projectFileChanges(call, generating) : [], [call, generating, extensionRendered]);
  const nested = Object.values(executionById ?? {}).filter(child => child.parentToolCallId === call.id);
  if (extensionRendered !== undefined) return <>{extensionRendered}</>;
  const mutationPhase = isFileChangeTool(call.name) ? fileChangePhase(execution, result, generating) : undefined;
  const status = mutationPhase === 'failed' || mutationPhase === 'partial' ? 'error' : result
    ? (result.isError ? 'error' : 'success')
    : execution?.status ?? 'running';
  const transientOutput = execution?.result ?? execution?.partialResult;
  const liveModels = projectToolCalls({ toolName: call.name,
    ...(transientOutput === undefined ? {} : { details: transientOutput }),
  }, execution?.status === 'running')?.calls.filter(row => row.name === 'models.classify' || row.name === 'models.generateImages') ?? [];
  const transientSubagentRun = (call.name === 'subagent' || call.name === 'subagent_wait') && transientOutput !== undefined
    ? parseSubagentRun(transientOutput)
    : undefined;
  const applyPatchFiles = call.name === 'apply_patch'
    ? getApplyPatchFileEntries(result?.details ?? transientOutput)
    : [];
  const details = result?.details ?? transientOutput;
  const compactSummary = getToolSummary({
    toolName: call.name,
    arguments: call.arguments,
    details,
  }).text;
  const harnessShellId = (call.name === 'bash' || call.name === 'get_output' || call.name === 'write_to_process' || call.name === 'kill_shell')
    ? harnessShellIdFromDetails(details)
    : null;
  const command = typeof call.arguments === 'object' && call.arguments && !Array.isArray(call.arguments)
    ? String((call.arguments as Record<string, unknown>).command ?? '')
    : '';
  if (call.name === 'explore') return <PiExploreCard call={call} cwd={cwd} execution={execution}
    result={result} generating={generating} rawDetails={<>
      <pre className="overflow-auto whitespace-pre-wrap break-words font-mono typography-micro">{jsonText(call.arguments)}</pre>
      {result ? <ToolResultContent messageId={`tool-result:${call.id}`} result={result} />
        : transientOutput !== undefined ? <RawJsonDetails value={transientOutput} /> : null}
    </>} />;
  return (
    <>
    {fileChanges.map((file, index) => <PiFileChangePreview key={`${index}:${file.path}`} file={file}
      previewId={`${call.id}:${index}:${file.path}`}
      phase={fileChangePhase(execution, result, generating, file.path)}
      onOpen={workspaceId ? () => revealResourceInEditor({
        workspaceId,
        resourceId: resourceIdFromWorkspacePath(cwd, file.path) ?? file.path.replace(/\\/g, '/'),
        workspaceRoot: cwd,
        ...(sessionId ? { sessionId } : {}),
        toolCallId: call.id,
      }) : undefined} />)}
    <PiToolDisclosure
      disclosureId={`tool:${call.id}`}
      className={cn(
        'group',
        'my-1',
        status === 'error' && 'text-[var(--status-error)]',
      )}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
        <Icon
          name={fileChanges.length ? 'code-sslash' : status === 'running' ? 'loader-4' : status === 'error' ? 'error-warning' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            !fileChanges.length && status === 'running' && 'animate-spin',
            status === 'error' && 'text-[var(--status-error)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={`${call.name}: ${compactSummary || call.name}`}>{fileChanges.length ? t('chat.fileChange.details') : compactSummary || call.name}</span>
        {harnessShellId ? (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 typography-micro text-foreground hover:bg-interactive-hover"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openHarnessTerminal(cwd, harnessShellId, command);
            }}
          >
            {t('chat.timeline.tools.openTerminal')}
          </button>
        ) : null}
        {!fileChanges.length ? <PiToolStatus status={status} /> : null}
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
        ) : transientSubagentRun ? (
          <SubagentRunView messageId={`tool-live:${call.id}`} presentation={transientSubagentRun} />
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
                  disabled={file.deleted}
                  onClick={() => {
                    const resourceId = resourceIdFromWorkspacePath(cwd, file.filePath)
                      ?? file.filePath.replace(/\\/g, '/');
                    if (workspaceId) {
                      revealResourceInEditor({
                        workspaceId,
                        resourceId,
                        workspaceRoot: cwd,
                        ...(sessionId ? { sessionId } : {}),
                        ...(call.id ? { toolCallId: call.id } : {}),
                      });
                    }
                  }}
                  className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:cursor-default disabled:opacity-50"
                >
                  <Icon name="file-code" className="size-3.5 shrink-0" />
                  <span className="max-w-64 truncate">{file.filePath}</span>
                </button>
              ))}
            </div>
            {applyPatchFiles.map((file) => (
              file.patch ? (
                <PatchHunkReview
                  key={`review:${file.filePath}`}
                  cwd={cwd}
                  filePath={file.filePath}
                  patch={file.patch}
                  {...(sessionId ? { sessionId } : {})}
                  {...(call.id ? { toolCallId: call.id } : {})}
                />
              ) : null
            ))}
          </div>
        ) : null}
      </div>
    </PiToolDisclosure>
    </>
  );
};

const PiReadOnlyToolGroup: React.FC<{
  calls: PiToolCall[];
  cwd: string;
  executionById: Record<string, PiToolExecutionState>;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
}> = ({ calls, cwd, executionById, resultByCallId }) => {
  const { t } = useI18n();
  const disclosureChoices = React.useContext(ToolDisclosureContext);
  const states = calls.map((call) => {
    const result = resultByCallId.get(call.id);
    return result ? (result.isError ? 'error' : 'success') : executionById[call.id]?.status ?? 'running';
  });
  const status = states.includes('running') ? 'running' : states.includes('error') ? 'error' : 'success';
  const counts = { reads: 0, searches: 0, inspections: 0 };
  for (const call of calls) {
    const name = call.name.toLowerCase().replace(/:\d+$/, '');
    if (name === 'read') counts.reads += 1;
    else if (['grep', 'find', 'glob', 'websearch'].includes(name)) counts.searches += 1;
    else counts.inspections += 1;
  }
  const summary = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => t(`chat.timeline.tools.${kind}`, { count: counts[kind] }))
    .join(' · ');
  return (
    <PiToolDisclosure disclosureId={`group:${calls[0]!.id}`}
      initiallyExpanded={calls.some((call) => disclosureChoices?.get(`tool:${call.id}`))}
      className="group/tools my-1">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
        <Icon
          name={status === 'running' ? 'loader-4' : status === 'error' ? 'error-warning' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            status === 'running' && 'animate-spin',
            status === 'error' && 'text-[var(--status-error)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={summary}>{summary}</span>
        {status === 'running' && states.includes('error') ? <PiToolStatus status="error" /> : null}
        <PiToolStatus status={status} />
        <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground transition-transform group-open/tools:rotate-180" />
      </summary>
      <div className="ml-2 border-l border-border/60 py-1 pl-3">
        {calls.map((call) => (
          <PiToolCard
            key={call.id}
            call={call}
            cwd={cwd}
            execution={executionById[call.id]}
            executionById={executionById}
            result={resultByCallId.get(call.id)}
          />
        ))}
      </div>
    </PiToolDisclosure>
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

const PiThinkingBody: React.FC<{
  content: PiThinkingContent;
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

const PiToolSequence: React.FC<{
  calls: PiToolCall[];
  cwd: string;
  generatingCallIds?: ReadonlySet<string>;
  executionById: Record<string, PiToolExecutionState>;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
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
    <PiToolCard
      key={group.entry.toolCallId}
      call={byId.get(group.entry.toolCallId)!}
      generating={generatingCallIds?.has(group.entry.toolCallId)}
      cwd={cwd}
      execution={executionById[group.entry.toolCallId]}
      executionById={executionById}
      result={resultByCallId.get(group.entry.toolCallId)}
    />
  ) : (
    <PiReadOnlyToolGroup
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
  executionById: Record<string, PiToolExecutionState>;
  hiddenThinkingLabel?: string;
  message: PiAssistantMessage;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  streaming?: boolean;
}> = ({ cwd, entryId, executionById, hiddenThinkingLabel, message, resultByCallId, streaming = false }) => {
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < message.content.length;) {
    const content = message.content[index]!;
    if (content.type === 'toolCall') {
      const consecutive: PiToolCall[] = [];
      while (index < message.content.length && message.content[index]?.type === 'toolCall') {
        consecutive.push(message.content[index] as PiToolCall);
        index += 1;
      }
      rendered.push(
        <PiToolSequence key={`tools:${consecutive[0]!.id}`} calls={consecutive}
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
              enableFileReferences
            />
          </ChatTextSource>,
        );
        index += 1;
        continue;
      }
      if (content.type === 'thinking') {
        const preview = content.redacted ? '' : thinkingPreview(content.thinking);
        rendered.push(
          <details
            key={`${entryId}:thinking:${index}`}
            className="group/thinking my-1"
            open={streaming && !content.redacted ? true : undefined}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl py-1.5 pr-2 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
              <Icon name="brain" className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium text-foreground/80">
                {hiddenThinkingLabel || 'Thinking'}{content.redacted ? ' (redacted)' : ''}
              </span>
              {!streaming && preview
                ? <span className="min-w-0 flex-1 truncate opacity-75">{preview}</span>
                : <span className="min-w-0 flex-1" />}
              <Icon name="arrow-right-s" className="size-3.5 shrink-0 transition-transform group-open/thinking:rotate-90" />
            </summary>
            {!content.redacted && (
              <div className="ml-2 border-l border-border/60 py-1 pl-3 text-muted-foreground">
                <PiThinkingBody
                  content={content}
                  messageId={`${entryId}:thinking:${index}`}
                  streaming={streaming && message.stopReason === 'pending' && index === message.content.length - 1}
                />
              </div>
            )}
          </details>,
        );
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

const PiSortedActivityGroup: React.FC<{
  cwd: string;
  executionById: Record<string, PiToolExecutionState>;
  hiddenThinkingLabel: string;
  projection: PiSortedTurnProjection;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
}> = ({ cwd, executionById, hiddenThinkingLabel, projection, resultByCallId }) => {
  const { t } = useI18n();
  const activityRenderMode = useUIStore((state) => state.activityRenderMode);
  const [expanded, setExpanded] = React.useState(activityRenderMode === 'summary');
  React.useEffect(() => {
    setExpanded(activityRenderMode === 'summary');
  }, [activityRenderMode]);

  const running = projection.activity.some((item) => (
    item.streaming
    || (item.kind === 'tool' && executionById[item.call.id]?.status === 'running')
  ));
  const failed = projection.activity.some((item) => {
    if (item.kind !== 'tool') return false;
    const execution = executionById[item.call.id];
    const result = resultByCallId.get(item.call.id);
    if (item.call.name === 'explore') return ['failed', 'partial', 'invalid', 'unavailable'].includes(explorePresentation(execution, result, item.streaming).phase);
    return result?.isError || execution?.status === 'error'
      || (isFileChangeTool(item.call.name) && ['failed', 'partial'].includes(fileChangePhase(execution, result, item.streaming)));
  });
  const latest = projection.activity.at(-1);
  const latestLabel = latest?.kind === 'tool'
    ? latest.call.name
    : latest?.kind === 'thinking'
      ? hiddenThinkingLabel
      : latest?.kind === 'justification'
        ? t('chat.reasoningTrace.justification')
        : '';

  return (
    <section
      className="min-w-0"
      data-pi-sorted-activity="true"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
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
        <span className="font-medium">{t('chat.piActivity.title')}</span>
        {latestLabel ? <span className="min-w-0 flex-1 truncate">· {latestLabel}</span> : <span className="flex-1" />}
        {failed ? <PiToolStatus status="error" /> : null}
        <span className="typography-micro">{projection.activity.length}</span>
        <Icon name="arrow-down-s" className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded ? (
        <div className="ml-2 space-y-2 border-l border-border py-2 pl-3">
          {projection.activity.map((item, index) => {
            if (item.kind === 'tool') {
              if (projection.activity[index - 1]?.kind === 'tool') return null;
              const calls: PiToolCall[] = [];
              const generatingCallIds = new Set<string>();
              for (let next = index; next < projection.activity.length; next += 1) {
                const candidate = projection.activity[next]!;
                if (candidate.kind !== 'tool') break;
                calls.push(candidate.call);
                if (candidate.streaming) generatingCallIds.add(candidate.call.id);
              }
              return <PiToolSequence key={item.id} calls={calls} cwd={cwd}
                generatingCallIds={generatingCallIds}
                executionById={executionById} resultByCallId={resultByCallId} />;
            }
            return (
              <React.Fragment key={item.id}>
                {item.kind === 'thinking' ? (
                  <div data-pi-activity-kind="thinking">
                    <div className="mb-1 flex items-center gap-1.5 typography-meta font-medium text-muted-foreground">
                      <Icon name="brain" className="size-3.5" />
                      {hiddenThinkingLabel}{item.content.redacted ? ' (redacted)' : ''}
                    </div>
                    {!item.content.redacted ? (
                      <div className="ml-2 border-l border-border/60 pl-3 text-muted-foreground">
                        <PiThinkingBody
                          content={item.content}
                          messageId={item.id}
                          streaming={item.streaming}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg bg-background/45 px-2.5 py-2" data-pi-activity-kind="justification">
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
                        enableFileReferences
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

export const PiTurnUserMessage: React.FC<{
  cwd: string;
  entry?: PiSessionMessageEntry;
  forkBusyEntryId?: string | null;
  message: PiUserMessage;
  onFork?(entry: PiSessionMessageEntry): void;
  onOpenThread?(entry: PiSessionMessageEntry, options: { carryBlocks: boolean }): void;
  onRecover?(entry: PiSessionMessageEntry): void;
  recoveryBusyEntryId?: string | null;
  status?: PiSessionSubmissionStatus;
  threadBusyEntryId?: string | null;
}> = ({
  cwd,
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
  const messageId = entry?.id ?? `live-user:${message.timestamp}`;
  const messageText = piContentText(message.content).trim();
  const copyMessage = React.useCallback(() => {
    if (!messageText) return;
    void copyTextToClipboard(messageText).then((result) => {
      if (result.ok) toast.success(t('sessions.sidebar.session.menu.copied'));
      else toast.error(result.error);
    });
  }, [messageText, t]);
  return (
    <article id={entry ? `pi-entry-${entry.id}` : undefined} data-pi-user-message data-pi-entry-id={entry?.id} className="group/message ml-auto max-w-[85%]">
      <div className="rounded-xl bg-[var(--chat-user-message-bg)] px-4 py-3 text-[var(--chat-user-message)]">
        <PiUserContentView content={message.content} messageId={messageId} />
      </div>
      {status ? (
        <div
          className={cn(
            'mt-1 flex items-center justify-end gap-1.5 px-1 typography-micro text-muted-foreground',
            status === 'failed' && 'text-[var(--status-error)]',
            status === 'uncertain' && 'text-[var(--status-warning)]',
          )}
          data-pi-submission-status={status}
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
          {t(`chat.piComposer.submission.${status}`)}
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
      {entry ? <HarnessThreadMarkers cwd={cwd} entryId={entry.id} /> : null}
    </article>
  );
};

export const PiTimelineEntryList: React.FC<Omit<
  PiTimelineProps,
  'assistantWaiting' | 'liveUser' | 'liveUserStatus'
> & {
  outputDurationsMs?: Readonly<Record<string, number>>;
  projectedResultByCallId?: ReadonlyMap<string, PiToolResultMessage>;
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
}) => {
  const { t } = useI18n();
  const chatRenderMode = useUIStore((state) => state.chatRenderMode);
  const messageRenderers = useWorkbenchMatchRenderers<{
    cwd: string;
    entry: PiSessionEntry;
    sessionId: string;
  }>('message-renderer', 'chat.timeline.entries');
  const projection = React.useMemo(
    () => projectPiTimeline(entries, liveAssistant),
    [entries, liveAssistant],
  );
  const resultByCallId = projectedResultByCallId ?? projection.resultByCallId;
  const extensionEntries = React.useMemo(() => {
    const renderedById = new Map<string, React.ReactNode>();
    for (const entry of projection.visibleEntries) {
      const rendered = renderFirstWorkbenchMatch(messageRenderers, { cwd, entry, sessionId });
      if (rendered !== undefined) renderedById.set(entry.id, rendered);
    }
    return renderedById;
  }, [cwd, messageRenderers, projection.visibleEntries, sessionId]);
  const builtInEntries = React.useMemo(
    () => projection.visibleEntries.filter((entry) => !extensionEntries.has(entry.id)),
    [extensionEntries, projection.visibleEntries],
  );
  const sortedProjection = React.useMemo(
    () => chatRenderMode === 'sorted'
      ? projectPiSortedTurn(builtInEntries, projection.liveAssistant)
      : undefined,
    [builtInEntries, chatRenderMode, projection.liveAssistant],
  );
  const resolvedThinkingLabel = hiddenThinkingLabel || t('chat.reasoningTrace.thinking');
  // The row owns the whole turn, independent of live/sorted presentation.
  // Only assistant prose belongs in copy/memory; thinking and tool output do
  // not. Native discussion/fork actions still need a persisted text message.
  const turnText = assistantMessagesForTurn(builtInEntries, projection.liveAssistant)
    .map((message) => message.content.filter((content) => content.type === 'text')
      .map((content) => content.text).join('\n').trim())
    .filter(Boolean).join('\n\n');
  const actionEntry = builtInEntries.filter((entry): entry is PiSessionMessageEntry => (
    entry.type === 'message' && entry.message.role === 'assistant'
      && entry.message.content.some((content) => content.type === 'text' && content.text.trim())
  )).at(-1);

  return (
    <PiToolDisclosureScope key={sessionId}>
    <div className="flex flex-col gap-3">
        {projection.visibleEntries.map((entry) => {
          if (extensionEntries.has(entry.id)) {
            return <React.Fragment key={entry.id}>{extensionEntries.get(entry.id)}</React.Fragment>;
          }
          if (entry.type === 'message') {
            const { message } = entry;
            if (message.role === 'user') {
              return (
                <PiTurnUserMessage
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
              const showsActivity = sortedProjection?.activityAnchorId === entry.id
                && sortedProjection.activity.length > 0;
              if (!displayedMessage && !showsActivity) return null;
              return (
                <article id={`pi-entry-${entry.id}`} data-pi-entry-id={entry.id} key={entry.id} className="group/message w-full space-y-3">
                  {showsActivity && sortedProjection ? (
                    <PiSortedActivityGroup
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
                  <HarnessThreadMarkers cwd={cwd} entryId={entry.id} />
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
                      Output was truncated by Pi; the complete output path is shown below when available.
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
              const notifications = message.customType === 'subagent-notify'
                ? parseSubagentNotifications(piContentText(message.content), message.details)
                : undefined;
              if (notifications) {
                return (
                  <SubagentNotificationsView
                    key={entry.id}
                    content={message.content}
                    details={message.details}
                    messageId={entry.id}
                    notifications={notifications}
                  />
                );
              }
              const subagentRun = message.customType === 'subagent-slash-result' && message.details !== undefined
                ? parseSubagentRun(message.details)
                : undefined;
              if (subagentRun) {
                return (
                  <article key={entry.id} className="w-full">
                    <SubagentRunView messageId={entry.id} presentation={subagentRun} />
                  </article>
                );
              }
              const extensionStatus = parseExtensionStatus(message.customType, message.details);
              if (extensionStatus) {
                return <PiExtensionStatusCard key={entry.id} messageId={entry.id} status={extensionStatus} />;
              }
              return (
                <MetaEntry key={entry.id} icon="plug-2">
                  <strong>{message.customType}</strong>
                  <PiUserContentView content={message.content} messageId={entry.id} />
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
            const notifications = entry.customType === 'subagent-notify'
              ? parseSubagentNotifications(piContentText(entry.content), entry.details)
              : undefined;
            if (notifications) {
              return (
                <SubagentNotificationsView
                  key={entry.id}
                  content={entry.content}
                  details={entry.details}
                  messageId={entry.id}
                  notifications={notifications}
                />
              );
            }
            const subagentRun = entry.customType === 'subagent-slash-result' && entry.details !== undefined
              ? parseSubagentRun(entry.details)
              : undefined;
            if (subagentRun) {
              return (
                <article key={entry.id} className="w-full">
                  <SubagentRunView messageId={entry.id} presentation={subagentRun} />
                </article>
              );
            }
            const extensionStatus = parseExtensionStatus(entry.customType, entry.details);
            if (extensionStatus) {
              return <PiExtensionStatusCard key={entry.id} messageId={entry.id} status={extensionStatus} />;
            }
            return (
              <MetaEntry key={entry.id} icon="plug-2">
                <strong>{entry.customType}</strong>
                <PiUserContentView content={entry.content} messageId={entry.id} />
                {entry.details !== undefined && <RawJsonDetails value={entry.details} />}
              </MetaEntry>
            );
          }
          if (entry.type === 'compaction' || entry.type === 'branch_summary') {
            const trace = entry.type === 'compaction' ? parseCompactionTraceDetails(entry.details) : null;
            return (
              <article key={entry.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 typography-meta font-medium text-muted-foreground">
                  <Icon name="contract-up-down" className="size-3.5" />
                  {entry.type === 'compaction' ? `Compaction · ${entry.tokensBefore} tokens` : 'Branch summary'}
                  {trace ? (
                    <button type="button" className="ml-auto text-primary hover:underline" onClick={() => {
                      window.dispatchEvent(new CustomEvent(PI_COMPACTION_TRACE_OPEN_EVENT, { detail: { sessionId, trace } }));
                    }}>
                      {t('harness.threads.transcript')}
                    </button>
                  ) : null}
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
            return <MetaEntry key={entry.id} icon="pie-chart">{entry.kind} · {entry.provider}/{entry.model} · {entry.usage.totalTokens} tokens · ${entry.usage.cost.total.toFixed(4)}</MetaEntry>;
          }
          if (entry.type === 'custom') {
            const extensionStatus = parseExtensionStatus(entry.customType, entry.data);
            if (extensionStatus) {
              return <PiExtensionStatusCard key={entry.id} messageId={entry.id} status={extensionStatus} />;
            }
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

        {projection.liveAssistant && (() => {
          const displayedMessage = chatRenderMode === 'sorted'
            ? sortedProjection?.answersBySourceId.get(PI_SORTED_LIVE_ASSISTANT_ID)
            : projection.liveAssistant;
          const showsActivity = sortedProjection?.activityAnchorId === PI_SORTED_LIVE_ASSISTANT_ID
            && sortedProjection.activity.length > 0;
          if (!displayedMessage && !showsActivity) return null;
          return (
            <article className="w-full space-y-3" aria-live="polite">
              {showsActivity && sortedProjection ? (
                <PiSortedActivityGroup
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
                  streaming={chatRenderMode === 'live'}
                />
              ) : null}
            </article>
          );
        })()}
        <PiTurnUsageFooter
          entries={entries}
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
        />
    </div>
    </PiToolDisclosureScope>
  );
};
