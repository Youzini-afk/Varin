import React from 'react';
import type { DelegatedExecution } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { ThreadChildReport } from './ThreadChildReport';
import { ThreadIntegrationPanel } from './ThreadIntegrationPanel';
import { ChildFileResult, ChildState } from '../conversation/childPresentation';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n, type I18nKey } from '@/lib/i18n';

const triggers: Record<DelegatedExecution['trigger']['kind'], I18nKey> = {
  dispatch: 'chat.children.trigger.dispatch', user_continuation: 'chat.children.trigger.user',
  computer_event: 'chat.children.trigger.computer', message_request: 'chat.children.trigger.message',
  followup: 'chat.children.trigger.followup', calendar: 'chat.children.trigger.calendar',
};

/** Each report and file publication remains attached to its actual execution. */
export function ThreadExecutions({ api, identity, executions }: { api: ThreadsAPI; identity: ThreadIdentity; executions: DelegatedExecution[] }) {
  const { t } = useI18n();
  return <div className="space-y-2">
    {executions.map((execution, index) => <details key={execution.execution_id} className="rounded-lg border border-border/50 px-3 py-2 typography-meta">
      <summary className="flex cursor-pointer items-center justify-between gap-2">
        <span>{execution.name || t(triggers[execution.trigger.kind])} · {index + 1}
          {execution.agent_id && <span className="ml-2 font-mono text-muted-foreground">{execution.agent_id}</span>}</span><ChildState state={execution.state} />
      </summary>
      <div className="mt-2 space-y-2">
        <ChildFileResult result={execution.code_result} />
        <ThreadIntegrationPanel api={api} identity={identity} execution={execution} />
        {execution.report?.detail && <MarkdownRenderer messageId={execution.execution_id} content={execution.report.detail} />}
        {execution.report?.history_ids.map(itemId => <ThreadChildReport key={itemId} api={api} identity={identity}
          operationId={execution.child_operation_id} executionId={execution.execution_id} itemId={itemId} />)}
      </div>
    </details>)}
  </div>;
}
