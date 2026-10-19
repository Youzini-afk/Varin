import type { ChildTask, DelegatedExecution } from '@varin/protocol';
import type { ThreadSnapshot } from '@varin/application-client';

export const childEnded = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);

function taskText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return;
  const input = value as { task?: unknown; content?: { text?: unknown } };
  if (typeof input.task === 'string') return input.task;
  if (typeof input.content?.text === 'string') return input.content.text;
}

export function childTaskRows(children: ChildTask[], executions: DelegatedExecution[], activity?: ThreadSnapshot['childActivity']) {
  const byChild = new Map<string, DelegatedExecution[]>();
  for (const execution of executions) {
    const history = byChild.get(execution.child_operation_id) ?? [];
    history.push(execution);
    byChild.set(execution.child_operation_id, history);
  }
  return children.map(child => {
    const history = byChild.get(child.operation_id) ?? [];
    const latest = history.at(-1);
    return { child, latest, history, task: taskText(latest?.input) ?? child.input.task,
      state: latest && activity?.[latest.execution_id]?.state || latest?.state || child.state };
  });
}
