import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';
import { toast } from '@/components/ui';
import { toolValueLabel } from './toolLabels';

const values = (value: unknown) => Array.isArray(value) ? value : [];
const position = (value: unknown, zeroBased = false): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= (zeroBased ? 0 : 1) ? value + (zeroBased ? 1 : 0) : undefined;

function SymbolChildren({ items, callId, path, prefix }: { items: unknown[]; callId: string; path: string; prefix: string }) {
  const { t } = useI18n();
  return <ToolDisclosure id={'symbols:' + prefix} className="tool-symbol-children">
    <summary className="typography-micro text-muted-foreground">{t('chat.tools.symbols')} · {items.length}</summary>
    <div>{items.map((value, index) => {
      const item = toolRecord(value), resource = toolRecord(item.resource);
      const targetPath = toolText(resource.resourceId) || path;
      const range = toolRecord(item.selectionRange ?? item.range);
      return <div key={index}><ToolFileLink callId={callId} path={targetPath} label={toolText(item.name)} line={position(toolRecord(range.start).line, true)} />
        {Array.isArray(item.children) && item.children.length > 0 && <SymbolChildren callId={callId} path={targetPath} items={item.children} prefix={prefix + ':' + index} />}</div>;
    })}</div>
  </ToolDisclosure>;
}

export function ToolFileLink({ callId, path, line, label }: { callId: string; path: string; line?: number; label?: string }) {
  const conversation = useOptionalConversationPresentation();
  return <button type="button" className="tool-file-link" title={path} disabled={!conversation || !path}
    onClick={() => void conversation?.openFile(callId, path, line).catch(error => toast.error(String(error)))}>
    <FileTypeIcon filePath={path} className="size-3.5 shrink-0" />
    <span className="truncate">{label || path}</span>{line !== undefined && <span className="shrink-0 font-mono typography-micro">L{line}</span>}
  </button>;
}

export function ToolResultNotice({ data, status }: { data: unknown; status: ToolViewProps['status'] }) {
  const { t } = useI18n();
  const value = toolRecord(data);
  const message = toolText(value.message) || toolText(value.error) || toolText(toolRecord(value.error).message) || toolText(value.detail) || toolText(value.reason);
  const incomplete = value.truncated === true || value.partial === true || typeof value.nextCursor === 'string';
  return <>{message && <p role={status === 'error' ? 'alert' : 'status'} className={'tool-result-notice typography-meta ' + (status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{message}</p>}
    {incomplete && <p className="typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</p>}</>;
}

export function ChatFileTools({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const rows = values(data.records).map(toolRecord);
  const reading = call.name === 'file_read', searching = call.name === 'file_search';
  const path = toolText(args.path);
  const roots = values(args.paths).filter(value => typeof value === 'string').join(', ');
  return <ToolDisclosure id={'tool:' + call.id} className="tool-file-activity group">
    <summary className="tool-resource-summary">
      {reading ? <FileTypeIcon filePath={path} className="size-3.5 shrink-0" /> : <Icon name={searching ? 'search' : 'folder-open'} className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate typography-meta" title={reading ? path : roots}>
        {reading ? path || t('chat.tools.readFile') : searching ? t('chat.tools.searchFor', { query: toolText(args.query) }) : t('chat.tools.listDirectory', { path: roots || '.' })}
      </span>
      {!reading && Array.isArray(data.records) && <span className="shrink-0 typography-micro">{t(searching ? 'chat.tools.matches' : 'chat.tools.entries', { count: rows.length })}</span>}
      {reading && typeof args.offset === 'number' && <span className="typography-micro text-muted-foreground">{t('chat.tools.readingRange', { offset: args.offset })}</span>}
      <span className={status === 'success' ? 'sr-only' : undefined}><ToolStatus status={status} generating={generating} /></span>
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" />
    </summary>
    <div className="tool-file-results">
      {reading && path && !generating && <ToolFileLink callId={call.id} path={path} />}
      {rows.length > 0 && <div className="tool-result-scroll" data-conversation-tool-scroll="true">
        {rows.map((row, index) => {
          const item = toolRecord(row.data), rowPath = toolText(row.path);
          const line = position(item.line);
          const directory = item.kind === 'directory';
          return <div key={rowPath + ':' + index} className="tool-search-hit">
            {directory ? <div className="tool-file-link"><Icon name="folder" className="size-3.5" /><span>{rowPath}</span></div>
              : <ToolFileLink callId={call.id} path={rowPath} line={line} />}
            {typeof item.preview === 'string' && <pre className="tool-hit-context"><code>
              {values(item.before).filter(value => typeof value === 'string').map((text, i) => <span key={'before:' + i}>{String(text) + '\n'}</span>)}
              <mark>{item.preview}</mark>
              {values(item.after).filter(value => typeof value === 'string').map((text, i) => <span key={'after:' + i}>{'\n' + String(text)}</span>)}
            </code></pre>}
          </div>;
        })}
      </div>}
      {Array.isArray(data.records) && rows.length === 0 && status === 'success' && <p className="typography-meta text-muted-foreground">{t('chat.tools.noResults')}</p>}
      <ToolResultNotice data={data} status={status} />
      {output}{details}
    </div>
  </ToolDisclosure>;
}

export function ChatLanguageTools({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const items = values(data.items).map(toolRecord);
  const path = toolText(args.path), diagnostic = call.name === 'language_diagnostics';
  const label = diagnostic ? t('chat.tools.diagnostics') : call.name === 'language_hover' ? t('chat.tools.symbolInfo')
    : call.name === 'language_definition' ? t('chat.tools.definition') : call.name === 'language_references' ? t('chat.tools.references')
      : call.name === 'language_call_hierarchy' ? t('chat.tools.callHierarchy') : t('chat.tools.symbols');
  return <ToolDisclosure id={'tool:' + call.id} className="tool-language-activity group" initiallyExpanded={diagnostic && items.length > 0}>
    <summary className="tool-resource-summary"><Icon name={diagnostic ? 'error-warning' : 'code-sslash'} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate typography-meta">{label} · {toolText(args.query) || path}</span>
      {Array.isArray(data.items) && <span className="typography-micro shrink-0">{t('chat.tools.entries', { count: items.length })}</span>}
      {(status !== 'success' || data.status !== 'ready') && <span className="typography-micro text-muted-foreground">{status !== 'success' ? <ToolStatus status={status} generating={generating} /> : toolValueLabel(data.status, t)}</span>}
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" /></summary>
    <div className="tool-language-results">
      {items.map((item, index) => {
        const target = toolRecord(item.to ?? item.from ?? item);
        const resource = toolRecord(target.resource);
        const range = toolRecord(target.targetSelectionRange ?? target.selectionRange ?? target.range);
        const line = position(toolRecord(range.start).line, true);
        const targetPath = toolText(resource.resourceId) || path;
        const contents = (Array.isArray(item.contents) ? item.contents : [item.contents]).map(value => typeof value === 'string' ? value : toolText(toolRecord(value).value)).filter(Boolean).join('\n\n');
        return <div key={index} className="tool-language-item">
          <ToolFileLink callId={call.id} path={targetPath} line={line} label={toolText(target.name) || undefined} />
          {typeof item.message === 'string' && <p className={item.severity === 1 ? 'text-destructive' : 'text-muted-foreground'}>{item.code !== undefined && <span className="font-mono typography-micro">{String(item.code)} · </span>}{item.message}</p>}
          {contents && <MarkdownRenderer content={contents} messageId={call.id + ':hover:' + index} variant="tool" enableFileReferences={false} />}
          {Array.isArray(target.children) && target.children.length > 0 && <SymbolChildren items={target.children} path={targetPath} callId={call.id} prefix={call.id + ':' + index} />}
          {Array.isArray(item.fromRanges) && <div className="tool-call-sites">{item.fromRanges.map((range, rangeIndex) => {
            const fromPath = toolText(toolRecord(toolRecord(item.from).resource).resourceId);
            return fromPath && <ToolFileLink key={rangeIndex} callId={call.id} path={fromPath} line={position(toolRecord(toolRecord(range).start).line, true)} />;
          })}</div>}
        </div>;
      })}
      {Array.isArray(data.items) && !items.length && data.status === 'ready' && <p className="typography-meta text-muted-foreground">{t('chat.tools.noResults')}</p>}
      <ToolResultNotice data={data} status={status} />
      {data.diagnosticVerification === 'unversioned' && <p className="typography-micro text-muted-foreground">{t('chat.tools.unverifiedDiagnostics')}</p>}
      {output}{details}
    </div>
  </ToolDisclosure>;
}

export function ChatRecoveryTools({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const data = toolRecord(result?.details ?? execution?.result), args = toolRecord(call.arguments);
  const restoring = call.name === 'file_restore';
  const points = values(data.points).map(toolRecord), files = values(data.files).map(toolRecord);
  const applied = values(data.appliedPaths), conflicts = values(data.conflictPaths);
  return <ToolDisclosure id={'tool:' + call.id} className="tool-recovery-activity group" initiallyExpanded={restoring && status !== 'running'}>
    <summary className="tool-resource-summary"><Icon name="history" className="size-3.5" />
      <span className="min-w-0 flex-1 typography-meta">{t(restoring ? 'chat.tools.restoreFiles' : 'chat.tools.recoveryPoints')}</span>
      {restoring && typeof data.status === 'string' && <span className={'typography-micro ' + (data.status === 'partial' || data.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{toolValueLabel(data.status, t)}</span>}
      <ToolStatus status={status} generating={generating} /><Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" /></summary>
    <div className="tool-recovery-timeline">
      {points.map((point, index) => <div key={toolText(point.id) || index} className="tool-recovery-point">
        <p className="typography-meta">{toolText(point.label) || toolText(point.id)}</p>
        <p className="typography-micro text-muted-foreground">{toolText(point.state)}{point.createdAt ? ' · ' + String(point.createdAt) : ''}</p>
        {values(point.paths).map((path, i) => typeof path === 'string' && <ToolFileLink key={i} callId={call.id} path={path} />)}
      </div>)}
      {Boolean(args.point || data.point) && <p className="typography-micro text-muted-foreground">{t('chat.tools.fromRecoveryPoint')} · {toolText(args.point) || toolText(toolRecord(data.point).label) || toolText(toolRecord(data.point).id) || toolText(data.point)}</p>}
      {files.map((file, index) => <div key={index} className="tool-recovery-file"><ToolFileLink callId={call.id} path={toolText(file.path)} />
        <span className={'typography-micro ' + (conflicts.includes(file.path) ? 'text-destructive' : 'text-muted-foreground')}>{toolText(file.status) || (applied.includes(file.path) ? t('chat.tools.restored') : '')}</span></div>)}
      {conflicts.length > 0 && <p className="typography-meta text-destructive">{t('chat.tools.restoreConflicts', { count: conflicts.length })}</p>}
      <ToolResultNotice data={data} status={status} />{output}{details}
    </div>
  </ToolDisclosure>;
}
