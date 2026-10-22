import React from 'react';
import type { ThreadIdentity, ThreadMaterialsAPI } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import type { FamilyMember, FetchResult, MaterialCollection, MaterialGrant } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { MaterialLinkContext } from '@/components/materials/MaterialLinkContext';
import { formatPdfMaterialCitationUrl } from '@/lib/materials/pdfMaterialCitation';
import { useI18n } from '@/lib/i18n';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolStatus } from './ToolDisclosure';
import { toolValueLabel } from './toolLabels';
import { ToolResultNotice } from './ChatResourceTools';
import { SourceLink } from './ChatSourceTools';
import { toolRecord, toolText } from './toolInvocation';
import { useToolAction } from './useToolAction';
import type { ToolViewProps } from './toolViewTypes';
import { ToolHeadingText } from './ToolHeadingText';
import { toolSubject } from './toolSubject';
import { useToolTargets } from './toolTargetContext';

export function MaterialSnapshotReader({ snapshotId, title, line = 1, onClose, reader, onQuote }: { snapshotId: string; title: string; line?: number; onClose(): void; reader?: { api: ThreadMaterialsAPI; identity: ThreadIdentity }; onQuote?(text: string): void }) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation(), openPdf = React.useContext(MaterialLinkContext);
  const [page, setPage] = React.useState<FetchResult>();
  const [start, setStart] = React.useState(line);
  const api = reader?.api ?? conversation?.api.materials, identity = reader?.identity ?? conversation?.identity;
  const threadId = identity?.threadId, branchId = identity?.branchId;
  const readerIdentity = React.useMemo(() => threadId && branchId ? { runtime: 'agent' as const, threadId, branchId } : undefined, [threadId, branchId]);
  React.useEffect(() => {
    if (!api || !readerIdentity) return;
    const abort = new AbortController();
    void api.read(readerIdentity, { snapshotId, position: { kind: 'lines', startLine: start, endLine: start + 119 } }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setPage(value); }, error => { if (!abort.signal.aborted) setPage({ status: 'failed', url: '', reason: String(error) }); });
    return () => abort.abort();
  }, [api, readerIdentity, snapshotId, start]);
  const data = toolRecord(page), snapshot = toolRecord(data.snapshot), range = toolRecord(data.range);
  const text = toolText(data.markdown);
  return <section className="tool-material-reader" aria-label={title}>
    <div className="tool-reader-heading"><strong>{title}</strong><button type="button" aria-label={t('chat.context.close')} onClick={onClose}><Icon name="close" className="size-4" /></button></div>
    {!page && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
    {text && <MarkdownRenderer messageId={'material:' + snapshotId + ':' + start} content={text} variant="tool" enableFileReferences={false} />}
    {page?.status !== 'ok' && page && <p role="alert" className="typography-meta text-destructive">{toolText(data.reason) || toolText(data.detail) || toolText(data.status)}</p>}
    <div className="tool-inline-actions">
      {start > 1 && <button type="button" onClick={() => { setPage(undefined); setStart(Math.max(1, start - 120)); }}>{t('chat.tools.previousPassage')}</button>}
      {typeof range.endLine === 'number' && typeof range.totalLines === 'number' && range.endLine < range.totalLines && <button type="button" onClick={() => { setPage(undefined); setStart(range.endLine as number + 1); }}>{t('chat.tools.nextPassage')}</button>}
      {text && (onQuote || conversation && !conversation.readOnly) && <button type="button" onClick={() => onQuote ? onQuote(text) : conversation?.quote(text)}>{t('chat.tools.quotePassage')}</button>}
      {toolRecord(snapshot.document).kind === 'pdf' && openPdf && <button type="button" onClick={() => openPdf(formatPdfMaterialCitationUrl({ snapshotId, page: 1 }), title)}>{t('chat.tools.openPdf')}</button>}
    </div>
  </section>;
}

function MaterialSharing({ collectionId }: { collectionId: string }) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const action = useToolAction('share:' + collectionId + ':' + conversation?.identity.threadId);
  const [members, setMembers] = React.useState<FamilyMember[]>([]), [cursor, setCursor] = React.useState<string | null>();
  const [selected, setSelected] = React.useState<string[]>([]), [grants, setGrants] = React.useState<MaterialGrant[]>([]);
  const keys = React.useRef(new Map<string, string>());
  const [open, setOpen] = React.useState(false);
  const family = conversation?.api.family, collectionApi = conversation?.api.materials.collection;
  if (!conversation || !family || !collectionApi || conversation.readOnly) return null;
  const load = () => action.run(signal => family.list(conversation.identity, { scope: 'all', ...(cursor ? { cursor } : {}) }, signal), page => {
    setMembers(previous => [...new Map([...previous, ...page.members].filter(member => member.threadId !== conversation.identity.threadId).map(member => [member.threadId, member])).values()]); setCursor(page.nextCursor ?? null);
  });
  return <div className="tool-material-sharing"><div className="tool-inline-actions"><button type="button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && cursor === undefined) void load(); }}><Icon name="group" className="size-3.5" />{t('chat.tools.shareMaterials')}</button></div>
    {open && <div className="tool-share-members">
      {members.map(member => <label key={member.threadId} className="tool-share-member"><input type="checkbox" disabled={action.busy || grants.some(grant => grant.toThreadId === member.threadId)} checked={selected.includes(member.threadId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, member.threadId] : previous.filter(id => id !== member.threadId))} />
        <AgentAvatar identity={member.threadId} avatar={member.avatar} size={23} /><span><strong>{member.name || member.agentId || member.threadId}</strong><small>{member.task}</small></span>{grants.some(grant => grant.toThreadId === member.threadId) && <Icon name="check" className="size-3.5" />}</label>)}
      {cursor && <button type="button" className="tool-text-button" disabled={action.busy} onClick={() => void load()}>{t('chat.tools.moreMembers')}</button>}
      <div className="tool-inline-actions"><button type="button" disabled={action.busy || !selected.some(id => !grants.some(grant => grant.toThreadId === id))} onClick={() => void action.run(async signal => {
        for (const id of selected.filter(id => !grants.some(grant => grant.toThreadId === id))) {
          const key = keys.current.get(id) ?? crypto.randomUUID(); keys.current.set(id, key);
          const response = await collectionApi(conversation.identity, { action: 'share', collectionId, targetThreadId: id, key }, signal);
          if (response.status !== 'ok' || !response.grant) throw new Error(response.message || response.status);
          if (!signal.aborted) setGrants(previous => [...previous, response.grant!]);
        }
      }, () => setOpen(false))}>{action.busy ? t('common.loading') : t('chat.tools.confirmShare')}</button></div>
    </div>}
    {grants.length > 0 && <p className="tool-share-receipt typography-micro" role="status"><Icon name="check" className="size-3" />{t('chat.tools.sharedWith', { names: grants.map(grant => members.find(member => member.threadId === grant.toThreadId)?.name || grant.toThreadId).join('、') })}</p>}
    {action.error && <p role="alert" className="typography-meta text-destructive">{action.error}</p>}
  </div>;
}

export function ChatMaterialsTool({ call, execution, result, status, generating, cwd, output, details }: ToolViewProps) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const targets = useToolTargets();
  const { isMobile } = useDeviceInfo();
  const data = toolRecord(result?.details ?? execution?.result);
  const action = useToolAction(call.id);
  const [inspected, setInspected] = React.useState<MaterialCollection>();
  const collection = inspected ?? toolRecord(data.collection);
  const members = Array.isArray(collection.members) ? collection.members.map(toolRecord) : [];
  const summaries = Array.isArray(data.collections) ? data.collections.map(toolRecord) : [];
  const hits = Array.isArray(data.hits) ? data.hits.map(toolRecord) : [];
  const [reading, setReading] = React.useState<{ id: string; title: string; line?: number }>();
  const openMaterial = (material: { id: string; title: string; line?: number }) => {
    if (!conversation || isMobile) { setReading(material); return; }
    useUIStore.getState().openContextPanelTab(cwd, { mode: 'material', thread: conversation.identity, targetPath: material.id,
      materialLine: material.line, label: material.title, readOnly: conversation.readOnly,
      dedupeKey: JSON.stringify([conversation.identity.threadId, conversation.identity.branchId, material.id]) });
  };
  const grant = toolRecord(data.grant);
  return <section className="tool-material-collection">
    <div className="tool-collection-heading"><Icon name="book-2" className="size-3.5" /><ToolHeadingText label={t('chat.tools.materials')} subject={toolSubject(call, { ...data, collection }, t, targets)} /><ToolStatus status={status} generating={generating} /></div>
    {members.map((member, index) => { const title = toolText(member.title) || toolText(toolRecord(member.paper).title) || toolText(member.url) || toolText(member.snapshotId); return <div className="tool-material-row" key={toolText(member.memberId) || index}>
      <Icon name={member.kind === 'paper' ? 'file-text' : member.kind === 'url' ? 'global' : 'file-list-2'} className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">{member.snapshotId && conversation ? <button type="button" className="tool-material-title" onClick={() => openMaterial({ id: toolText(member.snapshotId), title })}>{title}<Icon name="arrow-right-up" className="size-3" /></button> : member.url ? <SourceLink url={toolText(member.url)}>{title}</SourceLink> : <strong>{title}</strong>}
        {Boolean(member.note) && <p className="typography-micro text-muted-foreground">{toolText(member.note)}</p>}</div>{Boolean(member.role) && <span className="typography-micro text-muted-foreground">{toolValueLabel(member.role, t)}</span>}
    </div>; })}
    {summaries.map((entry, index) => <div className="tool-material-row" key={toolText(entry.collectionId) || index}><Icon name="folder-open" className="size-4" /><button type="button" className="tool-material-title min-w-0 flex-1" disabled={!conversation?.api.materials.collection || action.busy} onClick={() => {
      if (conversation?.api.materials.collection) void action.run(signal => conversation.api.materials.collection!(conversation.identity, { action: 'inspect', collectionId: toolText(entry.collectionId) }, signal), response => { if (!response.collection) throw new Error(response.message || response.status); setInspected(response.collection); });
    }}>{toolText(entry.name) || toolText(entry.collectionId)}</button><span className="typography-micro text-muted-foreground">{t('chat.tools.entries', { count: typeof entry.memberCount === 'number' ? entry.memberCount : 0 })}</span></div>)}
    {hits.length > 0 && <ol className="tool-source-results">{hits.map((hit, index) => <li key={index}><span className="tool-source-number">{index + 1}</span><div><button type="button" className="tool-material-title" disabled={!conversation} onClick={() => openMaterial({ id: toolText(hit.snapshotId), title: toolText(hit.memberId), line: typeof hit.line === 'number' ? hit.line : 1 })}>{toolText(hit.memberId)} · L{String(hit.line)}</button><p className="tool-source-snippet">{toolText(hit.excerpt)}</p></div></li>)}</ol>}
    {typeof grant.toThreadId === 'string' && <div className="tool-share-receipt"><AgentAvatar identity={grant.toThreadId} size={21} /><span>{t('chat.tools.sharedWith', { names: grant.toThreadId })}</span></div>}
    {typeof collection.collectionId === 'string' && <MaterialSharing collectionId={collection.collectionId} />}
    {reading && <MaterialSnapshotReader key={reading.id + ':' + reading.line} snapshotId={reading.id} title={reading.title} line={reading.line} onClose={() => setReading(undefined)} />}
    {Array.isArray(data.unreadable) && data.unreadable.length > 0 && <p className="typography-micro text-muted-foreground">{t('chat.tools.unreadableMembers', { count: data.unreadable.length })}</p>}
    {action.error && <p role="alert" className="typography-meta text-destructive">{action.error}</p>}
    <ToolResultNotice data={data} status={status} />{output}{details}
  </section>;
}
