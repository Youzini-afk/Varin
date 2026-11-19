import React from 'react';
import { botGroupRequest, downloadBotGroupFile, uploadBotGroupFile, createScheduledTasksHttpAPI, getRuntimeEndpointGeneration, getThreadObservationBus, type BotGroupMember, type BotGroupPage, type BotGroupPost, type BotGroupSummary, type BotSummary, type GroupChange, type GroupChatFile, type GroupDelivery, type ScheduledTask, type ThreadIdentity, type ThreadsAPI, type ThreadSnapshot } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { CollaborationConversation } from '@/components/thread/CollaborationConversation';
import { ThreadPermission } from '@/components/thread/ThreadPermission';
import { ThreadQuestions } from '@/components/thread/ThreadQuestions';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import type { Followup } from '@varin/protocol';
import { followupStatus, followupTrigger, pendingFollowup } from '@/lib/followupPresentation';
import { CalendarTaskEditorDialog } from '@/components/session/CalendarTaskEditorDialog';
import { formatSchedule } from '@/components/session/scheduleFormat';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { BotFigure } from './BotFigure';
import { groupLabel as L, groupChatError as messageError } from './botGroupChatModel';
import './bot-group-chat.css';

const pathFor = (id: string) => '/' + encodeURIComponent(id);
const working = (delivery: GroupDelivery) => delivery.state === 'queued' || delivery.state === 'running';
const troubled = (delivery: GroupDelivery) => ['asleep', 'failed', 'execution-failed'].includes(delivery.state);
const clock = (ms: number) => new Date(ms).toLocaleTimeString(getCurrentIntlLocale(), { hour: '2-digit', minute: '2-digit' });

export function GroupFaces({ group, bots, size = 22 }: { group: BotGroupSummary; bots: BotSummary[]; size?: number }) {
  return <span className="group-chat-faces" aria-hidden="true">{group.members.slice(0, 2).map(member => {
    const bot = bots.find(value => value.id === member.botId);
    return <span key={member.membership} style={{ width: size, height: size }}>{bot ? <BotFigure bot={bot} state="idle" size={size} still /> : member.name.slice(0, 1)}</span>;
  })}</span>;
}

export function GroupChatCreate({ bots, open, onClose, onCreated }: { bots: BotSummary[]; open: boolean; onClose(): void; onCreated(group: BotGroupSummary): void }) {
  const [name, setName] = React.useState('');
  const [members, setMembers] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onCreated(await botGroupRequest<BotGroupSummary>('', { name, members })); setName(''); setMembers([]); }
    catch (error) { setError(messageError(error)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>{L('create')}</DialogTitle><DialogDescription>{L('choose')}</DialogDescription></DialogHeader>
      <form onSubmit={event => void submit(event)} className="grid gap-3">
        <input autoFocus className="group-chat-field" value={name} onChange={event => setName(event.target.value)} placeholder={L('name')} aria-label={L('name')} />
        <div className="max-h-56 overflow-auto">{bots.filter(bot => !bot.archived && !bot.deletion).map(bot => <label className="group-chat-person" key={bot.id}>
          <BotFigure bot={bot} state="idle" size={23} still /> <span>{bot.name}</span>
          <input type="checkbox" checked={members.includes(bot.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, bot.id] : previous.filter(id => id !== bot.id))} />
        </label>)}</div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter><Button type="submit" disabled={busy || !name.trim() || !members.length}>{L('createAction')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function BotGroupChat({ group, bots, api, sequence, panel, mobile, closePanel, refresh, onDelete, onDirect, onWake }: {
  group: BotGroupSummary; bots: BotSummary[]; api: ThreadsAPI | null | undefined; sequence: number; panel: boolean; mobile: boolean;
  closePanel(): void; refresh(): void; onDelete(): void; onDirect(botId: string): void; onWake(bot: BotSummary): void;
}) {
  const id = pathFor(group.id);
  const [page, setPage] = React.useState<BotGroupPage>();
  const [older, setOlder] = React.useState<BotGroupPost[]>([]);
  const [before, setBefore] = React.useState<string>();
  const [anchor, setAnchor] = React.useState<string>();
  const [search, setSearch] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<GroupChatFile[]>();
  const [draftFiles, setDraftFiles] = React.useState<{ id: string; file: File }[]>([]);
  const [draft, setDraft] = React.useState('');
  const [addressed, setAddressed] = React.useState<string[]>([]);
  const [quote, setQuote] = React.useState<{ post: BotGroupPost; reply: boolean }>();
  const [picker, setPicker] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<'members' | 'activity' | 'schedule'>('members');
  const [memberDetail, setMemberDetail] = React.useState<string>();
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [work, setWork] = React.useState<{ title: string; identity: NonNullable<GroupDelivery['identity']> }>();
  const [streaming, setStreaming] = React.useState<Record<string, Record<string, string>>>({});
  const scroller = React.useRef<HTMLDivElement>(null);
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const draftId = React.useRef<string | null>(null);
  const atEnd = React.useRef(true);
  const members = page?.members ?? group.members;
  const setQuery = (value: string | null) => { setSearch(value); setOlder([]); setBefore(undefined); setAnchor(undefined); };
  React.useEffect(() => {
    const controller = new AbortController();
    const query = search ? '?q=' + encodeURIComponent(search) : '';
    const path = anchor ? id + '/post/' + encodeURIComponent(anchor) : id + query;
    void botGroupRequest<BotGroupPage>(path, undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value);
    }, error => { if (!controller.signal.aborted) setError(messageError(error)); });
    return () => controller.abort();
  }, [id, sequence, search, anchor]);

  const posts = [...new Map([...older, ...(page?.posts ?? [])].map(post => [post.id, post])).values()];
  const active = posts.flatMap(post => post.delivery.filter(delivery => delivery.state === 'running' && delivery.identity && delivery.runId));
  const activeKey = JSON.stringify(active.map(value => [value.identity!.threadId, value.identity!.branchId, value.runId]));
  React.useEffect(() => {
    if (!api) return;
    const identities = JSON.parse(activeKey) as [string, string, string][];
    const remove = identities.map(([threadId, branchId, runId]) => getThreadObservationBus(api).subscribe({ threadId, branchId, kinds: ['progress'] }, frame => {
      if (!('stream' in frame) || frame.stream !== 'progress' || frame.runId !== runId) return;
      const event = frame.event as { kind?: string; events?: { kind: string; data: { kind?: string; item_id?: string; text?: string } }[] };
      if (event.kind !== 'batch') return;
      const additions = event.events?.filter(value => value.kind === 'provider' && value.data?.kind === 'text_delta' && value.data.item_id && value.data.text);
      if (!additions?.length) return;
      setStreaming(previous => {
        const next = { ...previous[runId] };
        for (const { data } of additions) next[data.item_id!] = (next[data.item_id!] ?? '') + data.text;
        return { ...previous, [runId]: next };
      });
    }));
    return () => remove.forEach(stop => stop());
  }, [activeKey, api]);

  React.useLayoutEffect(() => {
    if (anchor && scroller.current) {
      scroller.current.querySelector(`[data-post="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    if (atEnd.current && scroller.current && search === null) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [page, streaming, search, anchor]);

  const replyId = quote?.reply && quote.post.author.kind === 'bot' ? quote.post.author.botId : null;
  const recipientIds = addressed.length ? addressed : replyId ? [replyId] : members.filter(member => member.listening).map(member => member.botId);
  const unknown = recipientIds.filter(botId => !members.some(member => member.botId === botId));
  const sleeping = bots.filter(bot => recipientIds.includes(bot.id) && bot.activity?.state === 'asleep');
  const displayName = (botId: string) => bots.find(bot => bot.id === botId)?.name ?? members.find(member => member.botId === botId)?.name ?? (quote?.post.author.kind === 'bot' && quote.post.author.botId === botId ? quote.post.author.name : L('left'));
  const authorName = (post: BotGroupPost) => post.author.kind === 'bot' ? displayName(post.author.botId) === L('left') ? post.author.name : displayName(post.author.botId) : '';
  const openDelivery = (delivery: GroupDelivery) => {
    if (delivery.identity) setWork({ identity: delivery.identity, title: displayName(delivery.botId) });
  };
  const change = async (input: GroupChange) => {
    setError('');
    try { await botGroupRequest(id + '/change', input); if (input.kind === 'delete') onDelete(); refresh(); }
    catch (error) { setError(messageError(error)); }
  };
  const send = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if ((!draft.trim() && !draftFiles.length) || unknown.length || busy) return;
    setBusy(true); setError('');
    draftId.current ??= crypto.randomUUID();
    try {
      const uploads = await Promise.all(draftFiles.map(entry => uploadBotGroupFile(id, entry.id, entry.file)));
      await botGroupRequest(id + '/post', { id: draftId.current, text: draft.trim(), addressed, quoteId: quote?.post.id, reply: quote?.reply, files: uploads.map(file => file.id) });
      draftId.current = null; setDraft(''); setDraftFiles([]); setAddressed([]); setQuote(undefined); setPicker(false); atEnd.current = true; refresh();
    } catch (error) { setError(messageError(error)); }
    finally { setBusy(false); composer.current?.focus(); }
  };
  const cite = (post: BotGroupPost, reply: boolean) => { setQuote({ post, reply }); composer.current?.focus(); };
  const closePicker = () => { setPicker(false); setMentionQuery(null); };
  const jump = (postId: string) => {
    const node = scroller.current?.querySelector<HTMLElement>(`[data-post="${CSS.escape(postId)}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else { setQuery(null); setAnchor(postId); }
  };
  const download = async (file: GroupChatFile) => {
    try {
      const url = URL.createObjectURL(await downloadBotGroupFile(id, file.id));
      const link = document.createElement('a');
      link.href = url; link.download = file.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { setError(messageError(error)); }
  };

  const memberPane = <div className="group-chat-panel">
    <header><GroupFaces group={group} bots={bots} size={31} /><b>{group.name}</b>
      <Button variant="ghost" size="icon" aria-label={L('cancel')} onClick={closePanel}><Icon name="close" className="size-4" /></Button>
      <small>{members.filter(member => member.listening).map(member => displayName(member.botId)).join('、')}{members.some(member => member.listening) && ' · ' + L('listening')}</small>
    </header>
    <nav>{(['members', 'activity', 'schedule'] as const).map(value => <button key={value} type="button" aria-pressed={tab === value} onClick={() => { setTab(value); setMemberDetail(undefined); }}>{L(value)}</button>)}</nav>
    {tab === 'members' ? <div className="group-chat-members">
      <div className="group-chat-list-actions"><button onClick={() => setAdding(value => !value)}>{L('add')}</button><button onClick={() => { setQuery(search === null ? '' : null); if (mobile) closePanel(); }}>{L('search')}</button>
        <button onClick={() => { void botGroupRequest<GroupChatFile[]>(id + '/files').then(setFiles, error => setError(messageError(error))); }}>{L('files')}</button></div>
      {adding && bots.filter(bot => !bot.archived && !bot.deletion && !members.some(member => member.botId === bot.id)).map(bot => <button className="group-chat-person w-full" key={bot.id} onClick={() => void change({ kind: 'add', botId: bot.id })}><BotFigure bot={bot} state="idle" size={24} still />{bot.name}<Icon name="add" className="ml-auto size-4" /></button>)}
      {members.map(member => {
        const bot = bots.find(value => value.id === member.botId);
        const state = active.some(delivery => delivery.botId === member.botId) ? L('thinking') : bot?.activity?.state === 'asleep' ? L('asleep') : '';
        return <React.Fragment key={member.membership}>
          <div className="group-chat-person"><button className="min-w-0 flex flex-1 items-center gap-2 text-left" onClick={() => setMemberDetail(memberDetail === member.botId ? undefined : member.botId)}>
            {bot && <BotFigure bot={bot} state="idle" size={26} still />}<span className="truncate">{displayName(member.botId)}{state && <small>{state}</small>}</span></button>
            <input type="checkbox" role="switch" title={L('listen')} aria-label={displayName(member.botId) + ' · ' + L('listen')} checked={member.listening} onChange={event => void change({ kind: 'listen', botId: member.botId, enabled: event.target.checked })} />
          </div>
          {memberDetail === member.botId && <div className="group-chat-member-detail">
            {bot && <BotFigure bot={bot} state="idle" size={72} still />}
            <p>{L('listen')}</p>
            {bot?.activity?.state === 'asleep' && <button onClick={() => onWake(bot)}>{L('wake')}</button>}
            <button onClick={() => onDirect(member.botId)}>{L('private')}</button>
            <button onClick={() => void change({ kind: 'remove', botId: member.botId })}>{L('remove')}</button>
          </div>}
        </React.Fragment>;
      })}
      <button className="group-chat-delete" onClick={() => setDeleting(true)}>{L('delete')}</button>
    </div> : tab === 'schedule' ? <GroupCalendar groupPath={id} members={members} refresh={refresh} api={api} /> : <div className="group-chat-activity">{[...posts].reverse().flatMap(post => post.delivery.filter(runningOrNotable).map(delivery =>
      <button key={post.id + delivery.membership} onClick={() => { if (delivery.identity) openDelivery(delivery); else { jump(post.id); if (mobile) closePanel(); } }}>
        <b>{displayName(delivery.botId)}</b><small>{working(delivery) ? L('thinking') : troubled(delivery) ? L('failed') : L('silent')}</small>
        <span>{post.text}</span>
      </button>))}</div>}
  </div>;

  return <div className="group-chat">
    <main className="group-chat-center">
      {search !== null && <div className="group-chat-search"><input autoFocus value={search} onChange={event => setQuery(event.target.value)} placeholder={L('search')} className="group-chat-field" /><Button variant="ghost" size="icon" aria-label={L('cancel')} onClick={() => setQuery(null)}><Icon name="close" className="size-4" /></Button></div>}
      <div className="group-chat-scroll" ref={scroller} onScroll={event => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 45; }}>
        <div className="group-chat-timeline">
          {anchor && <button className="group-chat-older" onClick={() => { atEnd.current = true; setQuery(null); }}>{L('latest')}</button>}
          {(before ?? (!older.length ? page?.before : undefined)) && <button className="group-chat-older" onClick={() => {
            const params = new URLSearchParams({ before: (before ?? page?.before)! });
            if (search) params.set('q', search);
            void botGroupRequest<BotGroupPage>(id + '?' + params).then(value => { setOlder(items => [...value.posts, ...items]); setBefore(value.before); }, error => setError(messageError(error)));
          }}>{L('older')}</button>}
          {!posts.length && <div className="group-chat-empty"><GroupFaces group={group} bots={bots} size={36} /><h2>{group.name}</h2><p>{page ? L('empty') : L('loading')}</p>{page && members[0] && <Button variant="outline" size="sm" onClick={() => { setAddressed([members[0]!.botId]); composer.current?.focus(); }}>@{displayName(members[0].botId)}</Button>}</div>}
          {posts.map((post, index) => {
            const previous = posts[index - 1];
            const bot = post.author.kind === 'bot' ? bots.find(value => value.id === (post.author as { botId: string }).botId) : undefined;
            const consecutive = previous && post.at - previous.at < 300_000 && JSON.stringify(previous.author) === JSON.stringify(post.author);
            const showQuote = post.quoteId && previous?.id !== post.quoteId && previous?.quoteId !== post.quoteId;
            if (post.author.kind === 'system') return <div className="group-chat-fact" key={post.id}>{post.fact && <>{post.fact.name} · {L('listening')} {post.fact.enabled ? '✓' : '–'}{post.fact.actor === 'bot' && ' · Bot'} · {clock(post.at)}</>}</div>;
            return <article className="group-chat-line" data-user={post.author.kind === 'user'} data-post={post.id} key={post.id}>
              <div className="group-chat-face">{bot && !consecutive && <BotFigure bot={bot} state="idle" size={29} still />}</div>
              <div className="group-chat-stack">
                {post.author.kind === 'bot' && (!consecutive || !!post.addressed.length || post.scheduleName || post.watchName) && <div className="group-chat-author">{authorName(post)}{post.addressed.length ? ' → ' + post.addressed.map(displayName).join('、') : ''}{post.informs && ' · ' + L('informed')}{post.scheduleName && ' · ' + L('schedule') + ' 「' + post.scheduleName + '」'}{post.watchName && ' · ' + L('watch') + ' 「' + post.watchName + '」'}</div>}
                <div className="group-chat-bubble">
                  {showQuote && post.quote && <button className="group-chat-quote" onClick={() => jump(post.quoteId!)}>{post.quote.author && post.quote.author + ' · '}{post.quote.text}</button>}
                  {post.text && <GroupText post={post} />}
                  {post.files?.map(file => <button key={file.id} className="group-chat-work" type="button" onClick={() => void download(file)}>
                    <Icon name="file" className="size-4 shrink-0" /><span>{file.filename}</span>
                  </button>)}
                  {post.work && <button className="group-chat-work" type="button" onClick={() => setWork(post.work)}>
                    <Icon name="chat-3" className="size-4 shrink-0" /><span>{post.work.title}</span><small>{L('openWork')}</small>
                  </button>}
                </div>
                <div className="group-chat-meta"><time>{clock(post.at)}</time>{post.delivery.map(delivery => {
                  const recipient = bots.find(value => value.id === delivery.botId);
                  return <span key={delivery.membership} className="group-chat-receipt" data-state={delivery.state} title={displayName(delivery.botId) + (delivery.state === 'silent' ? ' · ' + L('silent') : working(delivery) ? ' · ' + L('thinking') : '')}>
                    {recipient ? <BotFigure bot={recipient} state="idle" size={16} still /> : displayName(delivery.botId).slice(0, 1)}
                  </span>;
                })}<div className="group-chat-message-actions"><button onClick={() => cite(post, true)}>{L('reply')}</button><button onClick={() => cite(post, false)}>{L('quote')}</button></div></div>
                {post.delivery.filter(troubled).map(delivery => <div className="group-chat-trouble" key={delivery.membership}>
                  {displayName(delivery.botId)} · {delivery.state === 'asleep' ? L('asleep') : delivery.state === 'failed' ? L('failed') : L('workFailed')}
                  {delivery.state === 'execution-failed' ? <button onClick={() => openDelivery(delivery)}>{L('openWork')}</button> : <button title={delivery.detail} onClick={() => void change({ kind: 'retry', postId: post.id, botId: delivery.botId })}>{L(delivery.state === 'asleep' ? 'wakeRetry' : 'retry')}</button>}
                </div>)}
              </div>
            </article>;
          })}
          {active.map(delivery => {
            const text = Object.values(streaming[delivery.runId!] ?? {}).join('\n\n');
            const bot = bots.find(value => value.id === delivery.botId);
            return <React.Fragment key={delivery.runId}>
              {text && <article className="group-chat-line"><div className="group-chat-face">{bot && <BotFigure bot={bot} state="idle" size={29} still />}</div>
                <div className="group-chat-stack"><div className="group-chat-author">{displayName(delivery.botId)}</div><div className="group-chat-bubble"><MarkdownRenderer messageId={delivery.runId!} content={text} isStreaming /></div></div>
              </article>}
              {api && <GroupRunInteractions api={api} delivery={delivery} name={displayName(delivery.botId)} />}
            </React.Fragment>;
          })}
        </div>
      </div>
      <div className="group-chat-compose-space">
        {!!active.length && <div className="group-chat-working"><span className="bot-ring" /> {active.map(value => displayName(value.botId)).join('、')} · {L('thinking')}</div>}
        {error && <div role="alert" className="group-chat-trouble">{error}</div>}
        <form className="group-chat-composer" onSubmit={event => void send(event)}>
          <input ref={fileInput} type="file" multiple hidden onChange={event => {
            const picked = Array.from(event.currentTarget.files ?? []).map(file => ({ file, id: crypto.randomUUID() }));
            setDraftFiles(current => [...current, ...picked]); event.currentTarget.value = '';
          }} />
          {quote && <div className="group-chat-quote-draft"><span>{L(quote.reply && !addressed.length ? 'reply' : 'quote')} {authorName(quote.post)} · {quote.post.text}</span><button type="button" onClick={() => setQuote(undefined)} aria-label={L('cancel')}>×</button></div>}
          {!!addressed.length && <div className="group-chat-addresses">{addressed.map(botId => <button type="button" key={botId} data-left={unknown.includes(botId)} onClick={() => setAddressed(value => value.filter(id => id !== botId))}>@{displayName(botId)} ×</button>)}</div>}
          {!!draftFiles.length && <div className="group-chat-addresses">{draftFiles.map(entry => <button type="button" key={entry.id} disabled={busy} onClick={() => setDraftFiles(value => value.filter(file => file.id !== entry.id))}>{entry.file.name} ×</button>)}</div>}
          {sleeping.map(bot => <div key={bot.id} className="group-chat-sleep-note">{bot.name} · {L('asleep')} <button type="button" onClick={() => onWake(bot)}>{L('wake')}</button></div>)}
          <textarea ref={composer} rows={2} value={draft} readOnly={busy} aria-label={L('write')} placeholder={members.some(member => member.listening) ? L('write') : L('empty')}
            onChange={event => {
              const text = event.target.value;
              setDraft(text);
              if ((event.nativeEvent as InputEvent).inputType === 'insertFromPaste') { closePicker(); return; }
              const token = /(^|\s)@([^\s]*)$/.exec(text);
              if (token && event.target.selectionStart === text.length) { setMentionQuery(token[2] ?? ''); setPicker(true); }
              else if (mentionQuery !== null) closePicker();
            }}
            onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') closePicker(); if (event.key === 'Enter' && !event.shiftKey && !picker) { event.preventDefault(); void send(); } }} />
          <div className="group-chat-composer-tools"><button type="button" onClick={() => fileInput.current?.click()} className="group-chat-at" aria-label={L('attach')} title={L('attach')}><Icon name="attachment-2" className="size-3.5" /></button>
            <button type="button" className="group-chat-at" onClick={() => setPicker(value => !value)} aria-label={L('members')}>@</button>
            <button type="button" className="group-chat-recipient" aria-expanded={picker} onClick={() => setPicker(value => !value)}>{recipientIds.length ? L('to') + ' ' + recipientIds.map(displayName).join('、') : L('record')}</button>
            <Button type="submit" size="icon" className="rounded-full" aria-label={L('send')} disabled={busy || !!unknown.length || (!draft.trim() && !draftFiles.length)}><Icon name="arrow-up" className="size-4" /></Button>
          </div>
          {picker && <div className="group-chat-picker">{members.filter(member => !mentionQuery || displayName(member.botId).toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase())).map(member => <label key={member.membership}>
            <input type="checkbox" checked={addressed.includes(member.botId)} onChange={event => {
              setAddressed(current => event.target.checked ? [...current, member.botId] : current.filter(id => id !== member.botId));
              if (mentionQuery !== null) { setDraft(text => text.replace(/(^|\s)@[^\s]*$/, '$1')); setMentionQuery(null); }
            }} />
            <span>{displayName(member.botId)}</span><small>{addressed.includes(member.botId) ? '@' : replyId === member.botId && !addressed.length ? L('reply') : member.listening && recipientIds.includes(member.botId) ? L('listening') : ''}</small>
          </label>)}<button type="button" onClick={() => { closePicker(); composer.current?.focus(); }}>{L('cancel')}</button></div>}
        </form>
      </div>
    </main>
    {panel && (mobile ? <Dialog open onOpenChange={open => { if (!open) closePanel(); }}><DialogContent showCloseButton={false} className="p-0 max-h-[85dvh] overflow-auto"><DialogTitle className="sr-only">{group.name}</DialogTitle>{memberPane}</DialogContent></Dialog> : memberPane)}
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{L('delete')}</DialogTitle><DialogDescription>{group.name}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setDeleting(false)}>{L('cancel')}</Button><Button variant="destructive" onClick={() => void change({ kind: 'delete' })}>{L('delete')}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={Boolean(files)} onOpenChange={open => { if (!open) setFiles(undefined); }}><DialogContent className="max-w-md"><DialogTitle>{L('files')}</DialogTitle>
      <div className="max-h-72 overflow-auto">{files?.map(file => <button key={file.id} className="group-chat-person w-full text-left" onClick={() => void download(file)}>
        <Icon name="file" className="size-4 shrink-0" />{file.filename}
      </button>)}</div></DialogContent></Dialog>
    <Dialog open={Boolean(work)} onOpenChange={open => { if (!open) setWork(undefined); }}><DialogContent className="flex max-w-4xl h-[80dvh] flex-col"><DialogTitle>{work?.title}</DialogTitle>
      {api && work?.identity && <div className="flex min-h-0 flex-1"><CollaborationConversation identity={work.identity} api={api} host={getRuntimeEndpointGeneration()} onQuote={text => { setDraft(value => value ? value + '\n' + text : text); setWork(undefined); }} /></div>}
    </DialogContent></Dialog>
  </div>;
}

function runningOrNotable(delivery: GroupDelivery) { return working(delivery) || troubled(delivery) || delivery.state === 'silent'; }

const scheduleApi = createScheduledTasksHttpAPI();
const botScheduleScope = (botId: string) => `bot:${botId}`;

function GroupCalendar({ groupPath, members, refresh, api }: { groupPath: string; members: BotGroupMember[]; refresh(): void; api: ThreadsAPI | null | undefined }) {
  const { t } = useI18n();
  const [tasks, setTasks] = React.useState<{ member: BotGroupMember; task: ScheduledTask }[]>();
  const [watches, setWatches] = React.useState<{ owner: string; task: Followup; target: ThreadIdentity }[]>([]);
  const [owner, setOwner] = React.useState('');
  const [editor, setEditor] = React.useState<{ member: BotGroupMember; target: ThreadIdentity; task: ScheduledTask | null }>();
  const [error, setError] = React.useState('');
  const [revision, reload] = React.useReducer((value: number) => value + 1, 0);
  const scopeKey = JSON.stringify(members.filter(member => member.calendar).map(member => [member.botId, member.name, member.calendar]));
  const watchScope = JSON.stringify(members.filter(member => member.conversation).map(member => [member.botId, member.name, member.conversation]));
  React.useEffect(() => subscribeVarinEvents(event => { if (event.type === 'scheduled-task-changed') reload(); }), []);
  React.useEffect(() => {
    const controller = new AbortController();
    const contexts = JSON.parse(scopeKey) as [string, string, ThreadIdentity][];
    void Promise.all(contexts.map(async ([botId, name, target]) => {
      const scheduled = await scheduleApi.list(botScheduleScope(botId), controller.signal);
      return scheduled.flatMap(task => task.target.kind === 'existing_work' && task.target.threadId === target.threadId && task.target.branchId === target.branchId
        ? [{ member: { botId, name, listening: false, membership: target.threadId, calendar: target }, task }] : []);
    })).then(value => { if (!controller.signal.aborted) { setTasks(value.flat()); setError(''); } },
      error => { if (!controller.signal.aborted) setError(messageError(error)); });
    return () => controller.abort();
  }, [scopeKey, revision]);
  React.useEffect(() => {
    if (!api) return;
    const targets = JSON.parse(watchScope) as [string, string, ThreadIdentity][];
    const bus = getThreadObservationBus(api);
    let pending: AbortController | undefined;
    const load = () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      void Promise.all(targets.map(async ([botId, owner, target]) => {
        const records = await api.followups.arrangements(target, botId, controller.signal);
        return records.filter(task => task.thread_id === target.threadId && task.branch_id === target.branchId && pendingFollowup(task))
          .map(task => ({ owner, task, target }));
      })).then(value => { if (!controller.signal.aborted) setWatches(value.flat()); },
        error => { if (!controller.signal.aborted) setError(messageError(error)); });
    };
    const stops = targets.map(([, , target]) => bus.subscribe({ threadId: target.threadId, branchId: target.branchId, kinds: ['followup.*'] }, load));
    load();
    return () => { pending?.abort(); stops.forEach(stop => stop()); };
  }, [api, watchScope]);
  const chosen = members.find(member => member.botId === owner) ?? members[0];
  const create = async () => {
    if (!chosen) return;
    try {
      const target = await botGroupRequest<ThreadIdentity>(groupPath + '/calendar-target', { botId: chosen.botId });
      setEditor({ member: chosen, target, task: null });
      setError('');
      refresh();
    } catch (error) { setError(messageError(error)); }
  };
  return <div className="group-chat-activity">
    {error && <div role="alert" className="group-chat-trouble">{error}</div>}
    {watches.map(({ owner, task, target }) => <button key={task.id} onClick={() => useUIStore.getState().openArrangements(target, task.id)}>
      <b>{task.name || followupTrigger(task, t)}</b><small>{owner}</small><span>{followupStatus(task, t)}</span>
    </button>)}
    {!tasks ? <p>{L('loading')}</p> : !tasks.length ? <p>{L('emptySchedule')}</p> : tasks.map(({ member, task }) =>
      <button key={member.botId + task.id} onClick={() => setEditor({ member, target: member.calendar!, task })}>
        <b>{task.name}</b><small>{member.name}</small><span>{formatSchedule(task, t)}</span>
      </button>)}
    {chosen && <div className="group-chat-list-actions">
      <select aria-label={L('members')} className="group-chat-field" value={chosen.botId} onChange={event => setOwner(event.target.value)}>
        {members.map(member => <option key={member.membership} value={member.botId}>{member.name}</option>)}
      </select>
      <Button variant="outline" size="sm" onClick={() => void create()}>{L('newSchedule')}</Button>
    </div>}
    {editor && <CalendarTaskEditorDialog open projectId={botScheduleScope(editor.member.botId)} task={editor.task} initialTarget={editor.target}
      onOpenChange={value => { if (!value) setEditor(undefined); }} onSave={async task => {
        await scheduleApi.upsert(botScheduleScope(editor.member.botId), task);
        reload(); setEditor(undefined);
      }} />}
  </div>;
}

function GroupRunInteractions({ api, delivery, name }: { api: ThreadsAPI; delivery: GroupDelivery; name: string }) {
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const [error, setError] = React.useState('');
  const identity = delivery.identity!;
  const { threadId, branchId } = identity;
  React.useEffect(() => {
    let pending: AbortController | undefined;
    const load = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      void api.snapshot({ runtime: 'agent', threadId, branchId }, request.signal).then(value => {
        if (!request.signal.aborted) { setSnapshot(value); setError(''); }
      }, error => { if (!request.signal.aborted) setError(messageError(error)); });
    };
    const stop = getThreadObservationBus(api).subscribe({ threadId, branchId, kinds: ['operation.*', 'permission.*', 'question.*', 'run.changed'] }, load);
    load();
    return () => { stop(); pending?.abort(); };
  }, [api, threadId, branchId]);
  const run = snapshot?.activeRun;
  const operations = snapshot?.operations.filter(operation => operation.run_id === delivery.runId && operation.phase === 'waiting'
    && (operation.executor === 'ask_user' || (operation.result?.kind === 'control' && (operation.result.value as { permission?: unknown } | null)?.permission))) ?? [];
  if (!operations.length && !error) return null;
  return <article className="group-chat-line">
    <div className="group-chat-face" />
    <div className="group-chat-stack"><b className="group-chat-author">{name}</b>
      {error && <p role="alert" className="group-chat-trouble">{error}</p>}
      {operations.map(operation => <ThreadPermission key={operation.id} operation={operation}
        enabled={run?.id === delivery.runId && !run?.cancel_requested}
        onDecide={(permissionId, decision) => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision })} />)}
      {operations.some(operation => operation.executor === 'ask_user') && <ThreadQuestions scopeKey={threadComposerKey(threadHostKey(), identity)} operations={operations}
        enabled={operation => run?.state === 'waiting' && !run.cancel_requested && run.waiting_on === operation.waiting_on}
        onRead={operation => api.operation(operation.id)} onCancel={operation => api.cancelOperation(operation.id)}
        onAnswer={(operation, answers) => api.answerQuestion({ ...identity, operationId: operation.id, answers })} />}
    </div>
  </article>;
}

function GroupText({ post }: { post: BotGroupPost }) {
  const [expanded, setExpanded] = React.useState(false);
  const long = post.text.length > 1400 || post.text.split('\n').length > 15;
  return <>
    <div className={long && !expanded ? 'group-chat-folded' : undefined}>
      <MarkdownRenderer content={post.text} messageId={post.id} />
    </div>
    {long && <button className="group-chat-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{L(expanded ? 'collapse' : 'expand')}</button>}
  </>;
}
