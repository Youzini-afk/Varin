import React from 'react';
import { composerWorkflowFailure } from './composerWorkflowState';
import { getRuntimeEndpointGeneration, threadMemorySourceText, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { prepareConversationDownload } from '@/lib/agent-runtime/conversationExport';

export function ThreadExportForm({ api, identity, snapshot }: { api: ThreadsAPI; identity: ThreadIdentity; snapshot: ThreadSnapshot }) {
  const { t } = useI18n();
  const [cut] = React.useState(() => ({ ...identity, headId: snapshot.historyPage.head }));
  const [host] = React.useState(getRuntimeEndpointGeneration);
  const [format, setFormat] = React.useState<'markdown' | 'json'>('markdown');
  const [tools, setTools] = React.useState(false), [attachments, setAttachments] = React.useState(false);
  const [first, setFirst] = React.useState(''), [last, setLast] = React.useState('');
  const [history, setHistory] = React.useState(snapshot.history), [previous, setPrevious] = React.useState(snapshot.historyPage.previous);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string>();
  const [download, setDownload] = React.useState<Awaited<ReturnType<typeof prepareConversationDownload>>>();
  const controller = React.useRef<AbortController | null>(null), retained = React.useRef(download), alive = React.useRef(true);
  const current = () => alive.current && host === getRuntimeEndpointGeneration();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); void retained.current?.dispose(); }; }, []);
  const run = async (action: () => Promise<void>) => {
    if (controller.current || !current()) return;
    controller.current = new AbortController(); setBusy(true); setError(undefined);
    try { await action(); } catch (cause) { if (current() && !controller.current?.signal.aborted) setError(composerWorkflowFailure(cause)); }
    finally { controller.current = null; if (current()) setBusy(false); }
  };
  const choice = (value: string, onChange: (value: string) => void, label: string) => <label className="block space-y-1"><span>{label}</span><select aria-label={label} value={value} disabled={busy} onChange={event => onChange(event.target.value)} className="w-full rounded border bg-background p-2">
    <option value="">{t('composer.workflow.allMessages')}</option>{history.map(item => <option key={item.id} value={item.id}>{item.source} · {threadMemorySourceText(item).slice(0, 80) || item.id}</option>)}
  </select></label>;
  return <div className="space-y-3 typography-ui-label">
    <p className="text-muted-foreground">{t('composer.export.range')} · {cut.headId ?? t('composer.workflow.emptyHistory')}</p>
    <label className="block space-y-1">{t('composer.export.format')}<select aria-label={t('composer.export.format')} value={format} disabled={busy} onChange={event => setFormat(event.target.value as 'markdown' | 'json')} className="block w-full rounded border bg-background p-2"><option value="markdown">Markdown</option><option value="json">JSON</option></select></label>
    {choice(first, setFirst, t('composer.workflow.firstMessage'))}{choice(last, setLast, t('composer.workflow.lastMessage'))}
    {previous && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => { if (!cut.headId || !previous) return; const page = await api.historyPage(identity, { headId: cut.headId, beforeId: previous }, controller.current!.signal); if (current()) { setHistory(old => [...page.items, ...old]); setPrevious(page.previous); } })}>{t('composer.menu.more')}</Button>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={tools} disabled={busy} onChange={event => setTools(event.target.checked)} />{t('composer.export.tools')}</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={attachments} disabled={busy} onChange={event => setAttachments(event.target.checked)} />{t('composer.workflow.includeAttachments')}</label>
    <p className="text-muted-foreground">{t('composer.workflow.exportPrivacy')}</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {download && <a href={download.url} download={download.filename} className="block text-primary underline">{t('composer.workflow.downloadReady')}</a>}
    <Button type="button" disabled={busy} onClick={() => void run(async () => { if (!api.workflows) return; const result = await prepareConversationDownload(api.workflows, { ...cut, format, includeTools: tools, includeAttachments: attachments, ...(first ? { firstItemId: first } : {}), ...(last ? { lastItemId: last } : {}) }, controller.current!.signal); if (!current()) { await result.dispose(); return; } await retained.current?.dispose(); retained.current = result; setDownload(result); })}>{t(busy ? 'common.loading' : 'composer.command.export')}</Button>
  </div>;
}
