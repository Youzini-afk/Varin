import type { ThreadDispatchReceipt, ThreadIdentity, ThreadsAPI } from '@varin/application-client';

/** Reads only the report owned by this exact accepted execution, never the newest child Run. */
export async function readComposerAssistResult(api: ThreadsAPI, identity: ThreadIdentity, receipt: ThreadDispatchReceipt, signal?: AbortSignal): Promise<{ status: 'pending' } | { status: 'ready'; text: string } | { status: 'failed'; message: string }> {
  if (!api.collaboration) throw new Error('Agent collaboration is unavailable');
  const executions = await api.collaboration.executions(identity, receipt.operationId, signal);
  const execution = executions.find(value => value.execution_id === receipt.executionId);
  if (!execution || execution.child_thread_id !== receipt.threadId || execution.child_branch_id !== receipt.branchId || execution.child_operation_id !== receipt.operationId) throw new Error('The original drafting task is unavailable');
  if (!execution.report) return ['preparation_failed', 'failed', 'cancelled', 'completed'].includes(execution.state) ? { status: 'failed', message: `The drafting task ended without a report (${execution.state})` } : { status: 'pending' };
  if (execution.report.outcome !== 'succeeded') return { status: 'failed', message: execution.report.detail || `The drafting task did not complete successfully (${execution.report.outcome})` };
  const text: string[] = [];
  for (const itemId of execution.report.history_ids) {
    let offset = 0, format: 'text' | 'output_body' | undefined, total: number | undefined;
    const fragments: string[] = [];
    while (true) {
      signal?.throwIfAborted();
      const page = await api.collaboration.readExecutionReport(identity, receipt.executionId, itemId, offset, undefined, signal);
      const next = offset + new TextEncoder().encode(page.text).byteLength;
      if (page.operation_id !== receipt.operationId || page.execution_id !== receipt.executionId || page.item_id !== itemId || page.offset !== offset
        || format !== undefined && page.format !== format || total !== undefined && page.total_bytes !== total
        || next > page.total_bytes || page.next_offset === null && next !== page.total_bytes
        || page.next_offset !== null && (page.next_offset !== next || next <= offset)) throw new Error('The original drafting report range changed');
      format = page.format; total = page.total_bytes; fragments.push(page.text);
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    const body = fragments.join('');
    if (format === 'text') text.push(body);
    else {
      const output = JSON.parse(body) as { parts?: Array<{ kind?: string; text?: string }> };
      if (!Array.isArray(output.parts)) throw new Error('The original drafting report is not a public output');
      text.push(output.parts.filter(part => part.kind === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'));
    }
  }
  if (!text.some(value => value.trim())) return { status: 'failed', message: 'The drafting task returned no text to edit' };
  return { status: 'ready', text: text.join('\n\n') };
}
