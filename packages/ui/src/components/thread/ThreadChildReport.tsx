import React from 'react';
import type { ChildReportPage, OutputBody } from '@varin/protocol';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { parseThreadOutput } from '@/lib/agent-runtime/thread-content';
import { ThreadOutput } from './ThreadMedia';
import { useI18n } from '@/lib/i18n';

type Props = { api: ThreadsAPI; identity: ThreadIdentity; operationId: string; executionId?: string; itemId: string; autoRead?: boolean };

/** Dispatch and subsequent execution reports retain their exact original history owner. */
export function ThreadChildReport(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ReportView key={JSON.stringify([host, props.identity, props.operationId, props.executionId, props.itemId])} {...props} host={host} />;
}
function ReportView({ api, identity, operationId, executionId, itemId, host, autoRead = false }: Props & { host: number }) {
  const { t } = useI18n();
  const [page, setPage] = React.useState<ChildReportPage>();
  const [output, setOutput] = React.useState<OutputBody>();
  const [progress, setProgress] = React.useState<{ bytes: number; total: number }>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => request.current?.abort(), []);
  const read = async () => {
    if (!api.collaboration) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && host === getRuntimeEndpointGeneration();
    setLoading(true); setError(''); setProgress(undefined);
    let offset = page?.format === 'text' ? page.next_offset ?? 0 : 0;
    let accepted: ChildReportPage | undefined = page;
    const fragments: string[] = [];
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const result = executionId
          ? await api.collaboration.readExecutionReport(identity, executionId, itemId, offset, undefined, controller.signal)
          : await api.collaboration.readReport(identity, operationId, itemId, offset, undefined, controller.signal);
        if (!current()) return;
        if (result.operation_id !== operationId || result.item_id !== itemId || typeof result.execution_id !== 'string'
          || !result.execution_id || (executionId !== undefined && result.execution_id !== executionId)
          || (result.format !== 'text' && result.format !== 'output_body') || typeof result.text !== 'string'
          || result.offset !== offset || !Number.isSafeInteger(result.total_bytes) || result.total_bytes < 0
          || (accepted && (result.execution_id !== accepted.execution_id || result.format !== accepted.format || result.total_bytes !== accepted.total_bytes))) {
          throw new Error('The original report identity or format changed. Retry the original report.');
        }
        const next = offset + new TextEncoder().encode(result.text).length;
        if (next > result.total_bytes || (result.next_offset === null ? next !== result.total_bytes
          : !Number.isSafeInteger(result.next_offset) || result.next_offset !== next || next <= offset || next >= result.total_bytes)) {
          throw new Error('The original report byte range is inconsistent. Retry the original report.');
        }
        accepted ??= result;
        if (result.format === 'text') {
          setOutput(undefined);
          setPage(previous => previous?.format === 'text' && result.offset > 0
            ? { ...result, offset: previous.offset, text: previous.text + result.text } : result);
          return;
        }
        fragments.push(result.text);
        setProgress({ bytes: next, total: result.total_bytes });
        if (result.next_offset === null) {
          let decoded: unknown;
          try { decoded = JSON.parse(fragments.join('')); }
          catch { throw new Error('The original report output is incomplete or invalid. Retry the original report.'); }
          const body = parseThreadOutput(decoded);
          if (current()) { setOutput(body); setPage(result); }
          return;
        }
        offset = result.next_offset;
      }
    } catch (value) {
      if (current()) setError(value instanceof Error ? value.message : 'Report unavailable. Retry the original report.');
    } finally { if (current()) { request.current = null; setLoading(false); setProgress(undefined); } }
  };
  const readRef = React.useRef(read);
  readRef.current = read;
  React.useEffect(() => { if (autoRead) void readRef.current(); }, [autoRead]);
  return <div aria-label={t('chat.children.report')} className="space-y-1 typography-meta">
    {error && <p role="alert">{error}</p>}
    {page?.format === 'text' && <MarkdownRenderer messageId={`${page.execution_id}:${itemId}`} content={page.text} />}
    {page?.format === 'output_body' && output && <ThreadOutput api={api} identity={identity}
      holder={{ kind: 'child_report', operationId, executionId: page.execution_id, itemId }} output={output} messageId={`${page.execution_id}:${itemId}`} />}
    {loading && <><p role="status">{t('common.loading')}{progress ? ` · ${Math.round(progress.bytes / progress.total * 100)}%` : ''}</p>
      <Button variant="ghost" size="sm" onClick={() => { request.current?.abort(); request.current = null; setLoading(false); setProgress(undefined); }}>{t('chat.plan.cancel')}</Button></>}
    {(!page || page.next_offset !== null) && <Button variant="ghost" size="sm" disabled={loading || !api.collaboration} onClick={() => void read()}>
      {error ? t('chat.timeline.retry') : page ? t('chat.children.readMore') : t('chat.children.report')}
    </Button>}
  </div>;
}
