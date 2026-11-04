import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
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
    citation: toolText(toolRecord(paper.source).citation), contentKind: 'paper-metadata', connection: toolText(paper.provider), snippet: toolText(paper.abstract), provenance: [paper.year, ...(Array.isArray(paper.authors) ? paper.authors.map(author => typeof author === 'string' ? author : toolText(toolRecord(author).name)) : [])].filter(Boolean).join(' · ') }))
    : items.flatMap(item => list(item.results).map(hit => ({ title: toolText(hit.title), url: toolText(hit.url),
      snippet: toolText(hit.snippet) || toolText(hit.summary), citation: toolText(toolRecord(hit.source).citation), contentKind: toolText(hit.contentKind),
      connection: toolText(hit.connectionId) || toolText(item.connectionId) || toolText(item.providerId), provenance: toolText(hit.publishedAt) })));
  const title = decision ? toolText(args.goal) : search ? toolText(args.query) || toolText(args.objective)
    || (Array.isArray(args.queries) ? args.queries.map(q => typeof q === 'string' ? q : toolText(toolRecord(q).query)).filter(Boolean).join(' · ') : '')
    || items.map(item => toolText(item.query)).filter(Boolean).join(' · ')
    : toolText(data.title) || toolText(data.finalUrl) || toolText(args.url) || toolText(args.path) || toolText(args.snapshotId);
  const candidates = list(args.candidates), ranked = list(data.ranked);
  const markdown = toolText(data.markdown);
  const documents = items.map(item => toolRecord(item.fetch)).filter(item => typeof item.markdown === 'string');
  const overview = toolRecord(data.overview), range = toolRecord(data.range);
  const completeness = toolRecord(data.completeness), download = toolRecord(completeness.download), extraction = toolRecord(completeness.extraction);
  const selection = toolRecord(data.selection);
  const contentLabels = { 'search-description': 'chat.tools.contentKind.search-description', 'provider-excerpt': 'chat.tools.contentKind.provider-excerpt',
    'generated-summary': 'chat.tools.contentKind.generated-summary', 'generated-answer': 'chat.tools.contentKind.generated-answer',
    'paper-metadata': 'chat.tools.contentKind.paper-metadata', 'page-text': 'chat.tools.contentKind.page-text' } as const;
  const contentKind = (kind: string) => kind in contentLabels ? t(contentLabels[kind as keyof typeof contentLabels]) : kind ? t('chat.tools.contentKind.unknown') : '';
  const diagnostics = items.filter(item => list(item.attempts).length > 1 || list(item.appliedFilters).length || (Array.isArray(item.notices) && item.notices.length));
  return <section className="tool-source-activity">
    <div className="tool-source-heading"><Icon name={decision ? 'list-check-2' : search ? 'search' : 'global'} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words typography-meta">{title || t(search ? 'chat.tools.searchSources' : 'chat.tools.readSource')}</span>
      {status !== 'success' && <ToolStatus status={status} generating={generating} />}
    </div>
    {results.length > 0 && <ol className="tool-source-results">
      {results.map((item, index) => <li key={item.url + ':' + index}>
        <span className="tool-source-number">{index + 1}</span><div className="min-w-0">
          <SourceLink url={item.url}>{item.title || item.url}</SourceLink>
          <p className="typography-micro text-muted-foreground">{[domain(item.url), item.provenance, contentKind(item.contentKind)].filter(Boolean).join(' · ')}</p>
          {item.snippet && <ToolDisclosure id={'source:' + call.id + ':' + item.url + ':' + index} className="tool-document-text" initiallyExpanded={item.snippet.length < 700}>
            <summary className="typography-micro text-muted-foreground">{t('chat.tools.sourceExcerpt')}</summary><p className="whitespace-pre-wrap break-words typography-meta">{item.snippet}</p>
          </ToolDisclosure>}
          {item.citation && <MarkdownRenderer content={`[${t('chat.tools.pinnedSource')}](${item.citation})`} messageId={call.id + ':source:' + index} variant="tool" enableFileReferences={false} />}
        </div></li>)}
    </ol>}
    {search && (Array.isArray(data.papers) || Array.isArray(data.items)) && !results.length && !documents.length && !Array.isArray(data.connections) && status === 'success' && data.status !== 'partial'
      && <p className="typography-meta text-muted-foreground">{t('chat.tools.noResults')}</p>}
    {list(data.connections).length > 0 && <ul className="space-y-1 typography-meta text-muted-foreground">{list(data.connections).map(connection => <li key={toolText(connection.id)} className="break-words">{[connection.name, connection.id, connection.providerId, connection.detail].filter(value => typeof value === 'string').join(' · ')}</li>)}</ul>}
    {(Array.isArray(data.notices) ? data.notices : []).filter((notice): notice is string => typeof notice === 'string').map((notice, index) => <p key={'notice:' + index} className="typography-meta text-muted-foreground">{notice}</p>)}
    {diagnostics.length > 0 && <ToolDisclosure id={'search-diagnostics:' + call.id} className="tool-document-text">
      <summary className="typography-micro text-muted-foreground">{t('chat.tools.sourceDiagnostics')}</summary>
      <div className="space-y-2 typography-meta text-muted-foreground">{diagnostics.map((item, index) => <div key={index}>
        <p className="break-words">{[item.query, item.connectionId, item.providerId].filter(value => typeof value === 'string').join(' · ')}</p>
        {list(item.attempts).map((attempt, i) => <p key={'attempt:' + i} className="break-words">{[attempt.connectionId, attempt.providerId, attempt.status, toolRecord(attempt.failure).kind, toolRecord(attempt.failure).message].filter(value => typeof value === 'string').join(' · ')}</p>)}
        {list(item.appliedFilters).map((filter, i) => <p key={'filter:' + i} className="break-words">{[filter.field, filter.method, filter.basis, filter.detail].filter(value => typeof value === 'string').join(' · ')}</p>)}
        {(Array.isArray(item.notices) ? item.notices : []).filter((notice): notice is string => typeof notice === 'string').map((notice, i) => <p key={'notice:' + i} className="break-words">{notice}</p>)}
      </div>)}</div>
    </ToolDisclosure>}
    {items.filter(item => item.status && !['ok', 'ready', 'completed'].includes(String(item.status))).map((item, index) =>
      <p key={index} className="tool-result-notice typography-meta text-muted-foreground">{[item.query, item.url, item.status, item.detail].filter(value => typeof value === 'string').join(' · ')}</p>)}
    {!search && !decision && <div className="tool-document-reading">
      {Boolean(data.finalUrl || args.url) && <SourceLink url={toolText(data.finalUrl) || toolText(args.url)}>{domain(toolText(data.finalUrl) || toolText(args.url))}</SourceLink>}
      {typeof data.status === 'string' && data.status !== 'ok' && <p className="typography-micro text-muted-foreground">{data.status}</p>}
      {download.status === 'partial' && <p role="status" className="typography-meta text-[var(--status-warning)]">{t('chat.tools.downloadIncomplete')}{typeof download.retainedBytes === 'number' ? ` (${download.retainedBytes} B)` : ''}</p>}
      {extraction.status === 'partial' && <p className="typography-meta text-[var(--status-warning)]">{t('chat.tools.extractionIncomplete')} {toolText(extraction.detail)}</p>}
      {selection.matched === false && <p className="typography-meta text-muted-foreground">{t('chat.tools.noPassages')}</p>}
      {typeof overview.pageCount === 'number' && <p className="typography-meta">{t('chat.tools.documentPages', { count: overview.pageCount })}</p>}
      {typeof range.startLine === 'number' && typeof range.endLine === 'number' && <p className="typography-micro text-muted-foreground">L{range.startLine}–L{range.endLine}{typeof range.totalLines === 'number' ? ' / ' + range.totalLines : ''}</p>}
      {list(data.passageCitations).length > 0 ? <MarkdownRenderer content={list(data.passageCitations).map(selected => `[L${selected.startLine}–L${selected.endLine}](${toolText(selected.citation)})`).join(' · ')} messageId={call.id + ':passages'} variant="tool" enableFileReferences={false} />
        : list(data.ranges).length > 1 && <p className="typography-micro text-muted-foreground">{list(data.ranges).map(selected => `L${selected.startLine}–L${selected.endLine}`).join(' · ')}</p>}
      {typeof data.citation === 'string' && <MarkdownRenderer content={`[${t('chat.tools.pinnedSource')}](${data.citation})`} messageId={call.id + ':citation'} variant="tool" enableFileReferences={false} />}
      {list(data.findHits).map((hit, index) => <div key={index} className="tool-document-match"><span className="typography-micro text-muted-foreground">{t('chat.tools.page', { page: typeof hit.page === 'number' ? hit.page : '' })}</span><p className="typography-meta">{toolText(hit.snippet)}</p></div>)}
      {Boolean(data.nextRead) && <p className="typography-micro text-muted-foreground">{t('chat.tools.moreSourceContent')}</p>}
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
    {research && list(data.issues).length > 0 && <ToolDisclosure id={'source-issues:' + call.id} className="tool-document-text">
      <summary className="typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</summary>
      <div className="space-y-1 typography-meta text-muted-foreground">{list(data.issues).map((issue, index) => <p key={index} className="break-words">{toolText(issue.message)}</p>)}</div>
    </ToolDisclosure>}
    {output}{details}
  </section>;
}
