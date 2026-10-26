import { parseThreadOutput } from '@/lib/agent-runtime/thread-content';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export interface ReceivedAgentMessage {
  kind: 'message' | 'report' | 'task';
  text: string;
  senderThreadId?: string;
  targetThreadId?: string;
  senderBranchId?: string;
  targetBranchId?: string;
  outcome?: string;
  detail?: string;
  report?: { operationId: string; executionId: string; itemIds: string[]; partial: boolean };
}

/** Read only native Agent-message holders. Ordinary message bodies and JSON stay opaque. */
export function receivedAgentMessage(input: {
  entryId: string; nativeId?: string; text: string; senderThreadId?: string; targetThreadId?: string;
}): ReceivedAgentMessage {
  const { entryId, nativeId, text, senderThreadId, targetThreadId } = input;
  const base: ReceivedAgentMessage = { kind: 'message', text, senderThreadId, targetThreadId };
  if (!nativeId || !senderThreadId) return base;
  if (nativeId === entryId && entryId.startsWith('external-child-report:')) {
    try {
      const payload = record(JSON.parse(text.slice(text.indexOf('\n') + 1))), report = record(payload.report), page = record(payload.page);
      if (report.conversationId === senderThreadId) return { ...base, kind: 'report', text: [typeof page.text === 'string' ? page.text : '', typeof report.detail === 'string' ? report.detail : ''].filter(Boolean).join('\n\n'), outcome: typeof report.status === 'string' ? report.status : undefined };
    } catch { /* An unrecognized body remains visible verbatim. */ }
  }
  if (nativeId.startsWith('message:')) {
    const envelope = /^Task message ([^\n]+)\nSender: ([^\n]+) \/ ([^\n]+)\nTarget: ([^\n]+) \/ ([^\n]+)\nActor: ([^\n]+)\nKind: (?:request|inform)\nReply to: [^\n]+\n\n([\s\S]*)$/.exec(text);
    if (envelope?.[1] === nativeId && envelope[2] === senderThreadId && envelope[4] === targetThreadId)
      return { ...base, text: envelope[7]!, senderBranchId: envelope[3], targetBranchId: envelope[5] };
    return base;
  }
  if (entryId.startsWith('child-report:') && nativeId === entryId && text.startsWith(`Report from child ${senderThreadId}. `)) {
    try {
      const payload = record(JSON.parse(text.slice(text.indexOf('\n') + 1)));
      const report = record(payload.report), preview = record(payload.preview);
      if (report.sender_thread_id !== senderThreadId || !Array.isArray(report.history_ids)) return base;
      const itemIds = report.history_ids.filter((id): id is string => typeof id === 'string');
      const detail = typeof report.detail === 'string' ? report.detail : '';
      let body = '';
      let reference: ReceivedAgentMessage['report'];
      if (typeof preview.operation_id === 'string' && entryId.endsWith(`:${preview.operation_id}`)
        && typeof preview.execution_id === 'string' && typeof preview.item_id === 'string' && itemIds.includes(preview.item_id)
        && typeof preview.text === 'string' && (preview.format === 'text' || preview.format === 'output_body')) {
        if (preview.format === 'text') body = preview.text;
        else if (preview.next_offset === null) {
          const output = parseThreadOutput(JSON.parse(preview.text));
          body = output.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n\n');
        }
        reference = { operationId: preview.operation_id, executionId: preview.execution_id, itemIds,
          partial: preview.next_offset !== null || !body.trim() || itemIds.length > 1 };
      } else if (itemIds.length) return base;
      return { ...base, kind: 'report', text: [body, detail].filter(Boolean).join('\n\n'),
        ...(reference ? { targetBranchId: entryId.slice('child-report:'.length, -(reference.operationId.length + 1)) } : {}),
        outcome: typeof report.outcome === 'string' ? report.outcome : undefined, detail, report: reference };
    } catch { return base; }
  }
  if (nativeId.startsWith('child-input:')) return { ...base, kind: 'task' };
  return base;
}

/** A literal preview of already available text, never a generated task summary. */
export function agentMessagePreview(text: string): string {
  return text.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
}
