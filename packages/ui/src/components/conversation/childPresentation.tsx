import type { ChildCodeResult, ChildTask, DelegatedExecution } from '@varin/protocol';
import type { ThreadSnapshot } from '@varin/application-client';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const childEnded = (state:string)=>['completed','failed','cancelled'].includes(state);
function taskText(value:unknown):string|undefined {
  if(typeof value==='string')return value;
  if(!value||typeof value!=='object')return;
  const input=value as {task?:unknown;content?:{text?:unknown}};
  if(typeof input.task==='string')return input.task;
  if(typeof input.content?.text==='string')return input.content.text;
}
export function childTaskRows(children:ChildTask[],executions:DelegatedExecution[],activity?:ThreadSnapshot['childActivity']) {
  const byChild=new Map<string,DelegatedExecution[]>();
  for(const execution of executions){const history=byChild.get(execution.child_operation_id)??[];history.push(execution);byChild.set(execution.child_operation_id,history);}
  return children.map(child=>{const history=byChild.get(child.operation_id)??[];const latest=history.at(-1);return {child,latest,history,task:taskText(latest?.input)??child.input.task,state:latest&&activity?.[latest.execution_id]?.state||latest?.state||child.state};});
}

const states: Record<string, I18nKey> = {
  queued: 'harness.threads.state.queued', preparing: 'harness.threads.state.starting',
  starting: 'harness.threads.state.starting', running: 'harness.threads.state.running',
  ready: 'harness.threads.state.running', stopping: 'chat.children.stopping',
  preparation_failed: 'chat.children.preparationFailed',
  waiting: 'harness.threads.state.waiting', completed: 'harness.threads.state.completed',
  failed: 'harness.threads.state.failed', cancelled: 'harness.threads.state.cancelled',
  settling: 'chat.children.settling',
};
export function ChildState({ state }: { state: string }) {
  const { t } = useI18n();
  return <span className={cn('shrink-0 typography-micro', state === 'failed' || state === 'preparation_failed' ? 'text-destructive'
    : state === 'waiting' ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
    {states[state] ? t(states[state]) : state}
  </span>;
}
export function ChildFileResult({ result }: { result: ChildCodeResult }) {
  const { t } = useI18n();
  const label: Partial<Record<ChildCodeResult['kind'], I18nKey>> = {
    published: 'chat.children.filesPublished', no_changes: 'chat.children.noChanges',
    pending: 'chat.children.settling', settling: 'chat.children.settling', candidate: 'chat.children.settling', unavailable: 'chat.children.filesUnavailable',
  };
  const key = label[result.kind];
  return key ? <p className={cn('typography-meta', result.kind === 'unavailable' ? 'text-destructive' : 'text-muted-foreground')}
    title={result.kind === 'unavailable' ? result.code : undefined}>{t(key)}</p> : null;
}
