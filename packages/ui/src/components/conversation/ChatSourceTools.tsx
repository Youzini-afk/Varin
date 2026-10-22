import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { isExternalHttpUrl, openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';

export function SourceLink({ url, children }: { url: string; children: React.ReactNode }) {
  return isExternalHttpUrl(url) ? <a href={url} target="_blank" rel="noopener noreferrer" className="tool-source-link"
    onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); void openExternalUrl(url); } }}>
    {children}<Icon name="external-link" className="size-3 shrink-0" /></a> : <span>{children}</span>;
}
const list = (value: unknown) => Array.isArray(value) ? value.map(toolRecord) : [];
const domain = (value: string) => { try { return new URL(value).hostname; } catch { return ''; } };

export function ChatWebTools({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const research = call.name === 'research_search', decision = call.name === 'research_decide';
  const search = call.name === 'websearch' || research;
  const items = list(data.items), papers = list(data.papers);
  const results = research ? papers.map(paper => ({ title: toolText(paper.title), url: toolText(paper.landingUrl) || toolText(paper.openAccessUrl),
    snippet: toolText(paper.abstract), provenance: [paper.year, ...(Array.isArray(paper.authors) ? paper.authors.map(author => typeof author === 'string' ? author : toolText(toolRecord(author).name)) : [])].filter(Boolean).join(' · ') }))
    : items.flatMap(item => list(item.results).map(hit => ({ title: toolText(hit.title), url: toolText(hit.url),
      snippet: toolText(hit.snippet) || toolText(hit.summary), provenance: toolText(hit.publishedAt) })));
  const title = decision ? toolText(args.goal) : search ? toolText(args.query) || toolText(args.objective)
    || (Array.isArray(args.queries) ? args.queries.map(q => typeof q === 'string' ? q : toolText(toolRecord(q).query)).filter(Boolean).join(' · ') : '')
    || items.map(item => toolText(item.query)).filter(Boolean).join(' · ')
    : toolText(data.title) || toolText(data.finalUrl) || toolText(args.url) || toolText(args.path) || toolText(args.snapshotId);
  const candidates = list(args.candidates), ranked = list(data.ranked);
  const markdown = toolText(data.markdown);
  const documents = items.map(item => toolRecord(item.fetch)).filter(item => typeof item.markdown === 'string');
  const overview = toolRecord(data.overview), range = toolRecord(data.range);
  return <section className="tool-source-activity">
    <div className="tool-source-heading"><Icon name={decision ? 'list-check-2' : search ? 'search' : 'global'} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words typography-meta">{title || t(search ? 'chat.tools.searchSources' : 'chat.tools.readSource')}</span>
      {status !== 'success' && <ToolStatus status={status} generating={generating} />}
    </div>
    {results.length > 0 && <ol className="tool-source-results">
      {results.map((item, index) => <li key={item.url + ':' + index}>
        <span className="tool-source-number">{index + 1}</span><div className="min-w-0">
          <SourceLink url={item.url}>{item.title || item.url}</SourceLink>
          <p className="typography-micro text-muted-foreground">{[domain(item.url), item.provenance].filter(Boolean).join(' · ')}</p>
          {item.snippet && <p className="tool-source-snippet">{item.snippet}</p>}
        </div></li>)}
    </ol>}
    {search && (Array.isArray(data.papers) || Array.isArray(data.items)) && !results.length && !documents.length && status === 'success'
      && <p className="typography-meta text-muted-foreground">{t('chat.tools.noResults')}</p>}
    {items.filter(item => item.status && !['ok', 'ready', 'completed'].includes(String(item.status))).map((item, index) =>
      <p key={index} className="tool-result-notice typography-meta text-muted-foreground">{[item.query, item.url, item.status, item.detail].filter(value => typeof value === 'string').join(' · ')}</p>)}
    {!search && !decision && <div className="tool-document-reading">
      {Boolean(data.finalUrl || args.url) && <SourceLink url={toolText(data.finalUrl) || toolText(args.url)}>{domain(toolText(data.finalUrl) || toolText(args.url))}</SourceLink>}
      {typeof data.status === 'string' && data.status !== 'ok' && <p className="typography-micro text-muted-foreground">{data.status}</p>}
      {typeof overview.pageCount === 'number' && <p className="typography-meta">{t('chat.tools.documentPages', { count: overview.pageCount })}</p>}
      {typeof range.startLine === 'number' && typeof range.endLine === 'number' && <p className="typography-micro text-muted-foreground">L{range.startLine}–L{range.endLine}{typeof range.totalLines === 'number' ? ' / ' + range.totalLines : ''}</p>}
      {list(data.findHits).map((hit, index) => <div key={index} className="tool-document-match"><span className="typography-micro text-muted-foreground">{t('chat.tools.page', { page: typeof hit.page === 'number' ? hit.page : '' })}</span><p className="typography-meta">{toolText(hit.snippet)}</p></div>)}
      {markdown && <ToolDisclosure id={'document:' + call.id} className="tool-document-text" initiallyExpanded>
        <summary className="typography-micro text-muted-foreground">{t('chat.tools.sourceExcerpt')}</summary>
        <div className="tool-result-scroll" data-conversation-tool-scroll="true"><MarkdownRenderer content={markdown} messageId={call.id + ':document'} variant="tool" enableFileReferences={false} /></div>
      </ToolDisclosure>}
    </div>}
    {documents.map((document, index) => <ToolDisclosure id={'fetched:' + call.id + ':' + index} key={index} className="tool-document-text">
      <summary className="typography-meta">{toolText(document.title) || toolText(document.finalUrl) || toolText(document.url)}</summary>
      <div className="tool-result-scroll" data-conversation-tool-scroll="true"><MarkdownRenderer content={toolText(document.markdown)} messageId={call.id + ':fetched:' + index} variant="tool" enableFileReferences={false} /></div>
    </ToolDisclosure>)}
    {decision && <ol className="tool-source-results">{ranked.map((entry, index) => {
      const candidate = candidates.find(item => item.id === entry.id);
      return <li key={toolText(entry.id) || index}><span className="tool-source-number">{index + 1}</span><div>
        <SourceLink url={toolText(candidate?.url)}>{toolText(candidate?.title) || toolText(entry.id)}</SourceLink>
        {entry.selected === true && <span className="ml-2 typography-micro text-muted-foreground">{t('chat.explore.selected')}</span>}
        {typeof candidate?.detail === 'string' && <p className="tool-source-snippet">{candidate.detail}</p>}</div></li>;
    })}</ol>}
    {decision && Boolean(data.fallback) && <p className="typography-micro text-muted-foreground">{t('chat.tools.orderFallback')}</p>}
    <ToolResultNotice data={data} status={status} />
    {output}{details}
  </section>;
}

export function ChatMcpTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const source = call.name.startsWith('mcp__') ? call.name.slice(5).split('__') : [];
  const server = toolText(args.server) || source[0] || 'MCP';
  const name = toolText(args.tool) || source.slice(1).join('__') || call.name;
  const job = execution?.operation?.host_job?.mcpTask;
  const objects = Object.fromEntries(Object.entries(data).filter(([key]) => !['content', 'isError', 'structuredContent', '_meta'].includes(key)));
  return <section className="tool-mcp-result">
    <div className="tool-service-byline"><Icon name="plug" className="size-3.5" /><span>{server}</span><span>·</span><span>{name}</span>
      {status !== 'success' && <ToolStatus status={status} generating={generating} />}</div>
    {job && <div className="tool-remote-task typography-meta">
      <span>{t('chat.tools.remoteTask')} · {job.task.status}</span>
      {job.availability === 'unavailable' && <p className="text-[var(--status-warning)]">{t('chat.tools.observationUnavailable')}</p>}
      {job.problem && <p className="text-muted-foreground">{job.problem.kind} · {job.problem.stage}</p>}
    </div>}
    {data.isError === true && <p className="typography-meta text-destructive">{t('chat.tools.remoteFailure')}</p>}
    {data.structuredContent !== undefined && <div className="tool-mcp-objects"><JsonSummaryView data={data.structuredContent} /></div>}
    {output}
    {data.structuredContent === undefined && Object.keys(objects).length > 0 && <JsonSummaryView data={objects} />}
    <ToolResultNotice data={data} status={status} />{details}
  </section>;
}
