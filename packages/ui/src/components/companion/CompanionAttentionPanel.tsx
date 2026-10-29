import React, { useEffect, useRef, useState } from 'react';
import type { ThreadAttentionItem, ThreadIdentity } from '@varin/application-client';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import type { CompanionAttentionView } from './attentionCoordinator';
import type { DirectorInteractionRoute } from './directorPresentation';
import { CompanionAttentionLedger } from './attentionLedger';

const kindKey = (kind: ThreadAttentionItem['kind']) => `companion.attention.${kind}` as I18nKey;
const same = (a: { threadId: string; branchId: string }, b: { threadId: string; branchId: string } | null) => a.threadId === b?.threadId && a.branchId === b?.branchId;
const identityOf = (row: { threadId: string; branchId: string }): ThreadIdentity => ({ runtime: 'agent', threadId: row.threadId, branchId: row.branchId });
const PAGE_SIZE = 20; // Rendering budget, never a limit on tasks or requests.
const buttonStyle: React.CSSProperties = { border: '1px solid #b9c8c6', borderRadius: 7, padding: '4px 7px', background: '#f2f5f4', color: '#253c3a', cursor: 'pointer' };

/** This is an explicit interactive surface, never the click-through ornament window. */
export function CompanionAttentionPanel({ attention, identity, focusTitle, onFocus, onOpenThread, onClose, onRefresh, directorMode = false, onClearInspection, interactionRoute }: {
  attention: CompanionAttentionView; identity: ThreadIdentity | null; focusTitle?: string;
  onFocus(identity: ThreadIdentity): void; onOpenThread(identity: ThreadIdentity): void;
  onClose(): void; onRefresh(): void; directorMode?: boolean; onClearInspection?(): void; interactionRoute?: DirectorInteractionRoute;
}) {
  const { t } = useI18n();
  const companionRole = directorMode && (interactionRoute === 'agent-companion' || interactionRoute === 'unknown');
  const close = useRef<HTMLButtonElement>(null);
  const ledger = useRef(new CompanionAttentionLedger());
  const [, redraw] = useState(0);
  const [pages, setPages] = useState([0, 0, 0]);
  const snapshot = attention.snapshot;
  const items = snapshot ? ledger.current.reconcile(snapshot) : [];
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const open = (item: ThreadAttentionItem) => { ledger.current.markViewed(item.key); redraw(value => value + 1); onOpenThread(identityOf(item)); };
  const pageControls = (index: number, count: number) => {
    const page = Math.min(pages[index] ?? 0, Math.max(0, Math.ceil(count / PAGE_SIZE) - 1));
    const change = (next: number) => setPages(old => old.map((value, i) => i === index ? next : value));
    return count > PAGE_SIZE ? <nav aria-label={t('companion.attention.pages')}><button style={buttonStyle} disabled={page === 0} onClick={() => change(page - 1)}>{t('companion.attention.previous')}</button>{' '}<span>{page + 1} / {Math.ceil(count / PAGE_SIZE)}</span>{' '}<button style={buttonStyle} disabled={(page + 1) * PAGE_SIZE >= count} onClick={() => change(page + 1)}>{t('companion.attention.next')}</button></nav> : null;
  };
  const pageRows = <T,>(rows: T[], index: number): T[] => {
    const page = Math.min(pages[index] ?? 0, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    return rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  };
  const groups = [items.filter(item => item.actionable), items.filter(item => !item.actionable)];
  return <section role="region" aria-label={t(companionRole ? 'companion.director.taskReminders' : 'companion.attention.title')} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }} style={{ color: '#253c3a', background: '#fafcf9f5', border: '1px solid #b9c8c6', borderRadius: 12, padding: 12, fontSize: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{t(companionRole ? 'companion.director.taskReminders' : 'companion.attention.title')}</strong>
      <button ref={close} style={buttonStyle} onClick={onClose} aria-label={t('companion.attention.close')}>×</button></div>
    <p>{identity ? t(directorMode ? 'companion.director.inspection' : 'companion.attention.focus', { title: focusTitle || t('companion.attention.untitled') }) : t(directorMode ? companionRole ? 'companion.director.taskOverview' : 'companion.director.overview' : 'companion.attention.noFocus')}</p>
    {directorMode && identity && onClearInspection && <button style={buttonStyle} onClick={onClearInspection}>{t('companion.director.clearInspection')}</button>}
    <p>{t('companion.attention.scope')}</p>
    {attention.health !== 'current' && <p role="status">{t(attention.health === 'unknown' ? 'companion.attention.stale' : 'companion.attention.sync')}</p>}
    <button style={buttonStyle} onClick={onRefresh} disabled={attention.refreshing}>{t('companion.attention.refresh')}</button>
    {snapshot && <>
      {attention.health === 'current' && <p>{snapshot.counts.actionRequired
        ? t('companion.attention.needsYou', { count: snapshot.counts.actionRequired, tasks: snapshot.counts.affectedBranches })
        : t('companion.attention.noRequests')}</p>}
      {groups.map((rows, index) => rows.length > 0 && <section key={index} aria-label={t(index === 0 ? 'companion.attention.requests' : 'companion.attention.results')}>
        <h3 style={{ fontSize: 12 }}>{t(index === 0 ? 'companion.attention.requests' : 'companion.attention.results')}</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>{pageRows(rows, index).map(item => {
          const branch = snapshot.branches.find(row => same(row, item));
          return <li key={item.key} style={{ borderTop: '1px solid #dce5df', padding: '9px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><AgentAvatar identity={item.threadId} avatar={branch?.avatar} size={21}/>
              <strong style={{ overflowWrap: 'anywhere' }}>{branch?.title || t('companion.attention.untitled')}</strong></div>
            <small style={{ overflowWrap: 'anywhere' }}>{item.branchId}</small>
            <p style={{ margin: '5px 0' }}>{t(kindKey(item.kind))}</p>
            {(branch?.archived || branch?.deleted) && <small>{t('companion.attention.hidden')}</small>}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              <button style={buttonStyle} onClick={() => open(item)}>{t('companion.attention.open')}</button>
              <button style={buttonStyle} disabled={same(item, identity)} onClick={() => onFocus(identityOf(item))}>{t(directorMode ? same(item, identity) ? 'companion.director.current' : 'companion.director.inspect' : same(item, identity) ? 'companion.attention.current' : 'companion.attention.follow')}</button>
            </div>
            {ledger.current.isViewed(item.key) && <small>{t('companion.attention.viewed')}</small>}
          </li>;
        })}</ul>{pageControls(index, rows.length)}
      </section>)}
      <details><summary>{t(directorMode ? 'companion.director.projects' : 'companion.attention.overview')}</summary><ul style={{ listStyle: 'none', padding: 0 }}>
        {pageRows(snapshot.branches, 2).map(branch => <li key={JSON.stringify([branch.threadId, branch.branchId])} style={{ padding: '7px 0', borderTop: '1px solid #dce5df' }}>
          <strong style={{ overflowWrap: 'anywhere' }}>{branch.title || t('companion.attention.untitled')}</strong><br/><small style={{ overflowWrap: 'anywhere' }}>{branch.branchId}</small>
          <p>{branch.hasUnsettledWork ? t('companion.attention.workContinues') : branch.latestRun?.state === 'completed' ? t('companion.attention.turnCompleted')
            : branch.currentRun ? t('companion.attention.running', { state: branch.currentRun.state }) : t('companion.attention.noActiveRun')}</p>
          {directorMode && <p>{items.filter(item => same(item, branch)).length
            ? [...new Set(items.filter(item => same(item, branch)).map(item => t(kindKey(item.kind))))].join(' · ')
            : t('companion.director.noProjectNotices')}</p>}
          <button style={buttonStyle} onClick={() => onOpenThread(identityOf(branch))}>{t('companion.attention.open')}</button>{' '}
          <button style={buttonStyle} disabled={same(branch, identity)} onClick={() => onFocus(identityOf(branch))}>{t(directorMode ? same(branch, identity) ? 'companion.director.current' : 'companion.director.inspect' : same(branch, identity) ? 'companion.attention.current' : 'companion.attention.follow')}</button>
        </li>)}
      </ul>{pageControls(2, snapshot.branches.length)}</details>
    </>}
  </section>;
}

/** Small readable cue. No global idle/completion claim; no per-token live announcements. */
export function CompanionAttentionSummary({ attention, focusTitle, focused, focusStatus, onInspect, directorMode = false, onClearInspection, interactionRoute }: {
  attention: CompanionAttentionView; focusTitle?: string; focused: boolean; focusStatus: string; onInspect(): void; directorMode?: boolean; onClearInspection?(): void; interactionRoute?: DirectorInteractionRoute;
}) {
  const { t } = useI18n();
  const companionRole = directorMode && (interactionRoute === 'agent-companion' || interactionRoute === 'unknown');
  const snapshot = attention.snapshot;
  const attentionText = attention.health !== 'current' ? t(attention.health === 'unknown' ? 'companion.attention.stale' : 'companion.attention.sync')
    : snapshot?.counts.actionRequired ? t('companion.attention.needsYou', { count: snapshot.counts.actionRequired, tasks: snapshot.counts.affectedBranches })
      : snapshot?.items.length ? t('companion.attention.otherUpdates', { count: snapshot.items.length }) : '';
  const first = snapshot?.items.find(item => item.actionable) ?? snapshot?.items.find(item => item.kind === 'effect_unknown') ?? snapshot?.items[0];
  const branch = first && snapshot?.branches.find(row => same(row, first));
  return <div style={{ textAlign: 'center', maxWidth: '100%', fontSize: 12 }}>
    <div title={focusTitle} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{focused ? t(directorMode ? 'companion.director.inspection' : 'companion.attention.focus', { title: focusTitle || t('companion.attention.untitled') }) : t(directorMode ? companionRole ? 'companion.director.taskOverview' : 'companion.director.overview' : 'companion.attention.noFocus')}</div>
    {focused && <div>{directorMode ? t('companion.director.projectStatus', { status: focusStatus }) : focusStatus}</div>}
    <div role="status" aria-live="polite" aria-atomic="true">{attentionText}{first && attention.health === 'current' ? ` · ${branch?.title || t('companion.attention.untitled')}: ${t(kindKey(first.kind))}` : ''}</div>
    <button style={buttonStyle} onClick={onInspect}>{t('companion.attention.check')}</button>
    {directorMode && focused && onClearInspection && <button style={buttonStyle} onClick={onClearInspection}>{t('companion.director.clearInspection')}</button>}
  </div>;
}
