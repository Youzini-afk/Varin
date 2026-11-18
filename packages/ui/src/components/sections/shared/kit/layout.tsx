/* Settings kit · page structure. Mirrors header/sec/row/link/disc/note/empty/cards/tabs/unitbar/dock/cat in kit.js. */
import React from 'react';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { notifySettingsDraftChanged, registerSettingsDraft } from '@/lib/settings/drafts';
import { getSettingsSaveState, subscribeToSettingsSaveState } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { SettingsNavigationContext } from '../settings-context';
import { Btn, Ic, Info, Tip } from './controls';
import { useSettingsShell } from './shell-context';

/* ── Saved feedback: instant-save pages flash "Saved" in the header ── */
type FlashState = 'idle' | 'saving' | 'saved' | 'error';
const flashListeners = new Set<(state: FlashState) => void>();
/** Pages whose owner does not report through the shared persistence state call this after an acknowledged save. */
export function flashSettingsSaved(state: Exclude<FlashState, 'idle'> = 'saved') { flashListeners.forEach(listener => listener(state)); }

function SavedIndicator() {
  const { t } = useI18n();
  const shared = React.useSyncExternalStore(subscribeToSettingsSaveState, getSettingsSaveState, getSettingsSaveState);
  const [state, setState] = React.useState<FlashState>('idle');
  const timer = React.useRef<number | undefined>(undefined);
  const show = React.useCallback((next: FlashState) => {
    window.clearTimeout(timer.current);
    setState(next);
    if (next === 'saved') timer.current = window.setTimeout(() => setState('idle'), 1600);
    if (next === 'saving') timer.current = window.setTimeout(() => setState(current => current), 0);
  }, []);
  const previous = React.useRef(shared);
  React.useEffect(() => {
    if (previous.current === shared) return;
    previous.current = shared;
    if (shared === 'saved') show('saved');
    else if (shared === 'error') show('error');
  }, [shared, show]);
  React.useEffect(() => { flashListeners.add(show); return () => { flashListeners.delete(show); window.clearTimeout(timer.current); }; }, [show]);
  if (state === 'error') return <span className="sk-saved err" role="alert"><Ic name="error-warning" size="xs" />{t('settings.common.status.saveFailed')}</span>;
  return <span className={cn('sk-saved', state === 'saved' && 'on')} aria-live="polite"><Ic name="check" size="xs" />{state === 'saved' ? t('settings.common.status.saved') : ''}</span>;
}

/* ── Scope label: where a setting is stored ── */
export function Scope({ icon = 'stack', label, hint }: { icon?: IconName; label: React.ReactNode; hint?: React.ReactNode }) {
  const node = <span className="sk-scope" tabIndex={hint ? 0 : undefined}><Ic name={icon} size="xs" /><span>{label}</span></span>;
  return hint ? <Tip text={hint}>{node}</Tip> : node;
}

/* ── Preference form page ── */
export interface PageProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  scope?: React.ReactNode;
  actions?: React.ReactNode;
  wide?: boolean;
  /** Content between the header and the first section (filters, scope switchers). */
  lead?: React.ReactNode;
  children: React.ReactNode;
  /** Floating save dock rendered over the canvas bottom. */
  dock?: React.ReactNode;
  className?: string;
  saved?: boolean;
  header?: boolean;
}
export function Page({ title, description, scope, actions, wide, lead, children, dock, className, saved = true, header = true }: PageProps) {
  return <>
    <div className="sk-scroll" data-settings-page-scroll="">
      <div data-settings-page="" className={cn('sk-page', wide && 'wide', className)}>
        {header ? <PageHeader title={title} description={description} scope={scope} actions={actions} saved={saved} /> : null}
        {lead ? <div className="sk-lead">{lead}</div> : null}
        {children}
      </div>
    </div>
    {dock}
  </>;
}
export function PageHeader({ title, description, scope, actions, saved = true }: Pick<PageProps, 'title' | 'description' | 'scope' | 'actions' | 'saved'>) {
  return <header className="sk-ph">
    <div className="sk-grow">
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {scope}
    </div>
    <div className="sk-acts">{saved ? <SavedIndicator /> : null}{actions}</div>
  </header>;
}

/* ── Section with an optional grouped panel ── */
export interface SectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Render children without the panel (cards, tables, custom layouts). */
  raw?: boolean;
  after?: React.ReactNode;
  item?: string;
  id?: string;
  className?: string;
  panelClassName?: string;
  children?: React.ReactNode;
  titleAccessory?: React.ReactNode;
}
export function Section({ title, description, actions, raw, after, item, id, className, panelClassName, children, titleAccessory }: SectionProps) {
  const hasHead = title != null || description != null || actions != null;
  if (!hasHead && !children && !after) return null;
  return <section id={id} data-settings-item={item} className={cn('sk-sec', className)}>
    {hasHead ? <div className="sk-sh">
      <div className="sk-grow">
        {title != null ? <h2>{title}{titleAccessory}</h2> : null}
        {description != null ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="sk-acts">{actions}</div> : null}
    </div> : null}
    {children == null || children === false ? null : raw ? children : <div className={cn('sk-panel', panelClassName)}>{children}</div>}
    {after}
  </section>;
}

/** Free content inside a panel, padded like a row. */
export function Pad({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('sk-pad', className)}>{children}</div>;
}

/* ── Rows ── */
export interface RowProps {
  label?: React.ReactNode;
  description?: React.ReactNode;
  info?: React.ReactNode;
  tag?: React.ReactNode;
  lead?: IconName;
  sub?: boolean;
  dim?: boolean;
  stack?: boolean;
  item?: string;
  error?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
  labelId?: string;
}
export function Row({ label, description, info, tag, lead, sub, dim, stack, item, error, className, children, labelId }: RowProps) {
  const empty = label == null && description == null;
  return <div data-settings-item={item} className={cn('sk-row', stack && 'stack', sub && 'sub', dim && 'dim', empty && 'empty-label', className)}>
    {lead ? <span className="sk-lead-ic"><Ic name={lead} size="sm" /></span> : null}
    <div className="sk-rl">
      {label != null ? <div className="sk-t" id={labelId}>{label}{info ? <Info>{info}</Info> : null}{tag}</div> : null}
      {description != null ? <div className="sk-d">{description}</div> : null}
      {error ? <div className="sk-err-text" role="alert">{error}</div> : null}
    </div>
    {children != null ? <div className="sk-rc">{children}</div> : null}
  </div>;
}

export function LinkRow({ label, description, lead, end, onClick, item, soft, tag }: { label: React.ReactNode; description?: React.ReactNode; lead?: IconName; end?: React.ReactNode; onClick(): void; item?: string; soft?: boolean; tag?: React.ReactNode }) {
  return <button type="button" data-settings-item={item} className={cn('sk-row link', soft && 'soft')} onClick={onClick}>
    {lead ? <span className="sk-lead-ic"><Ic name={lead} size="sm" /></span> : null}
    <div className="sk-rl">
      <div className="sk-t">{label}{tag}</div>
      {description ? <div className="sk-d">{description}</div> : null}
    </div>
    <div className="sk-rc">{end ? <span className="sk-muted sk-small">{end}</span> : null}<Ic name="arrow-right-s" size="sm" /></div>
  </button>;
}

export function Disclosure({ label, summary, defaultOpen, open, onToggle, children, item }: { label: React.ReactNode; summary?: React.ReactNode; defaultOpen?: boolean; open?: boolean; onToggle?(open: boolean): void; children: React.ReactNode; item?: string }) {
  return <details className="sk-disc" data-settings-item={item} open={open ?? defaultOpen} onToggle={(event) => onToggle?.((event.currentTarget as HTMLDetailsElement).open)}>
    <summary><Ic name="arrow-right-s" size="sm" className="sk-chev" />{label}{summary ? <span className="sk-sum">{summary}</span> : null}</summary>
    <div className="sk-body2">{children}</div>
  </details>;
}

export function Note({ kind, icon, inPanel, children, actions, className }: { kind?: 'warn' | 'err' | 'ok'; icon?: IconName; inPanel?: boolean; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return <div className={cn('sk-note', kind, inPanel && 'inpanel', className)} role={kind === 'err' ? 'alert' : undefined}>
    <Ic name={icon ?? (kind === 'warn' || kind === 'err' ? 'error-warning' : kind === 'ok' ? 'checkbox-circle' : 'information')} size="sm" />
    <div>{children}{actions ? <div className="sk-note-acts">{actions}</div> : null}</div>
  </div>;
}

export function Empty({ icon, title, description, action }: { icon: IconName; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="sk-empty"><span className="sk-ei"><Ic name={icon} size="lg" /></span><b>{title}</b>{description ? <p>{description}</p> : null}{action}</div>;
}

export function Loading({ label }: { label?: React.ReactNode }) {
  const { t } = useI18n();
  return <div className="sk-loading" role="status"><span className="sk-spin" />{label ?? t('common.loading')}</div>;
}

/* ── Option cards ── */
export interface CardOption<T extends string> { value: T; label: React.ReactNode; description?: React.ReactNode; icon?: IconName; art?: React.ReactNode; disabled?: boolean; extra?: React.ReactNode }
export function OptionCards<T extends string>({ value, options, onChange, columns, label }: { value: T; options: readonly CardOption<T>[]; onChange(value: T): void; columns?: number; label?: string }) {
  return <div className="sk-cards" role="radiogroup" aria-label={label} style={{ '--n': columns ?? options.length } as React.CSSProperties}
    onKeyDown={event => {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (!direction) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      const next = buttons[(index + direction + buttons.length) % buttons.length]!;
      event.preventDefault();
      next.focus();
      next.click();
    }}>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} disabled={option.disabled}
      className="sk-ocard" onClick={() => { if (option.value !== value) onChange(option.value); }}>
      {option.art ? <div className="sk-art">{option.art}</div> : null}
      <div className="sk-oh">{option.icon ? <Ic name={option.icon} size="sm" /> : null}{option.label}<span className="sk-radio" /></div>
      {option.description ? <div className="sk-od">{option.description}</div> : null}
      {option.extra}
    </button>)}
  </div>;
}

/* ── In-page tabs ── */
export function Tabs<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: readonly { value: T; label: React.ReactNode; count?: number | null }[]; onChange(value: T): void; label?: string }) {
  return <nav className="sk-tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <button key={tab.value} type="button" role="tab" aria-selected={tab.value === value} onClick={() => onChange(tab.value)}>
      {tab.label}{tab.count != null ? <span className="sk-count">{tab.count}</span> : null}
    </button>)}
  </nav>;
}

/* ── Save units: inline bar for connection details, floating dock for documents ── */
export type UnitState = 'idle' | 'dirty' | 'busy' | 'ok' | 'err';
export interface UnitProps {
  dirty: boolean;
  saving?: boolean;
  error?: React.ReactNode;
  /** Briefly confirm after an acknowledged save. */
  savedMessage?: React.ReactNode;
  message?: React.ReactNode;
  busyMessage?: React.ReactNode;
  saveLabel?: React.ReactNode;
  saveDisabled?: boolean;
  onSave?: () => unknown | Promise<unknown>;
  onCancel: () => void;
  /** Register with the leave-page guard. Default true. */
  guard?: boolean;
  extra?: React.ReactNode;
}
function useUnit({ dirty, saving = false, error, saveDisabled = false, onSave, onCancel, guard = true }: UnitProps) {
  const guardNavigation = React.useContext(SettingsNavigationContext);
  const id = React.useId();
  const latest = React.useRef({ dirty, saving, saveDisabled, onSave, onCancel });
  React.useLayoutEffect(() => { latest.current = { dirty, saving, saveDisabled, onSave, onCancel }; });
  React.useEffect(() => (guard && guardNavigation ? registerSettingsDraft(id, () => latest.current) : undefined), [guard, guardNavigation, id]);
  React.useEffect(() => { notifySettingsDraftChanged(); }, [dirty, saving, saveDisabled]);
  React.useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saving]);
  const [ok, setOk] = React.useState(false);
  const wasSaving = React.useRef(saving);
  React.useEffect(() => {
    if (wasSaving.current && !saving && !dirty && !error) {
      setOk(true);
      const timer = window.setTimeout(() => setOk(false), 1800);
      wasSaving.current = saving;
      return () => window.clearTimeout(timer);
    }
    wasSaving.current = saving;
    return undefined;
  }, [saving, dirty, error]);
  const state: UnitState = saving ? 'busy' : error ? 'err' : dirty ? 'dirty' : ok ? 'ok' : 'idle';
  return state;
}
function UnitContent({ state, props }: { state: UnitState; props: UnitProps }) {
  const { t } = useI18n();
  const message = state === 'busy' ? <><span className="sk-spin" />{props.busyMessage ?? t('settings.common.actions.saving')}</>
    : state === 'ok' ? <><Ic name="check" size="sm" />{props.savedMessage ?? t('settings.common.status.saved')}</>
      : state === 'err' ? <><Ic name="error-warning" size="sm" />{props.error}</>
        : state === 'dirty' ? props.message ?? t('assistant.unsaved') : props.message;
  return <>
    <span className="sk-grow" role="status" aria-live="polite">{message}</span>
    {props.extra}
    {state === 'dirty' || state === 'err' ? <>
      <Btn kind="ghost" sm onClick={props.onCancel}>{t('settings.kit.discard')}</Btn>
      <Btn kind="primary" sm disabled={props.saveDisabled || !props.onSave || !props.dirty} onClick={() => { void props.onSave?.(); }}>{props.saveLabel ?? t('settings.kit.save')}</Btn>
    </> : null}
  </>;
}
export function UnitBar(props: UnitProps & { standalone?: boolean }) {
  const state = useUnit(props);
  const visible = state !== 'idle' || Boolean(props.extra);
  return <div className={cn('sk-unitbar', visible && 'on', props.standalone && 'standalone')} inert={!visible} aria-hidden={!visible}>
    <div><div className={cn('sk-in', state === 'ok' && 'ok', state === 'err' && 'err')}><UnitContent state={state} props={props} /></div></div>
  </div>;
}
export function SaveDock(props: UnitProps) {
  const state = useUnit(props);
  const visible = state !== 'idle' || Boolean(props.extra);
  return <div className={cn('sk-dock', visible && 'on')} inert={!visible} aria-hidden={!visible}>
    <div className={cn('sk-in', state === 'ok' && 'ok', state === 'err' && 'err')}><UnitContent state={state} props={props} /></div>
  </div>;
}

/* ── Object catalog ── */
export interface CatalogProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  scope?: React.ReactNode;
  headActions?: React.ReactNode;
  filter?: { value: string; onChange(value: string): void; placeholder: string };
  items: React.ReactNode;
  foot?: React.ReactNode;
  detail: React.ReactNode;
  dock?: React.ReactNode;
  /** Selection key: changing it scrolls the detail to the top and replays its entrance. */
  detailKey?: string;
  wideDetail?: boolean;
}
export function Catalog({ title, description, scope, headActions, filter, items, foot, detail, dock, detailKey, wideDetail }: CatalogProps) {
  const shell = useSettingsShell();
  const scroller = React.useRef<HTMLDivElement>(null);
  const first = React.useRef(true);
  React.useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    scroller.current?.scrollTo?.({ top: 0 });
  }, [detailKey]);
  return <div className="sk-cat" data-mstage={shell.catalogStage}>
    <aside className="sk-cat-list">
      <div className="sk-cat-head">
        <div className="sk-tt"><h1>{title}</h1>{headActions}</div>
        {description ? <p>{description}</p> : null}
        {scope}
      </div>
      {filter ? <div className="sk-cat-filter"><Ic name="search" size="sm" /><input value={filter.value} placeholder={filter.placeholder} aria-label={filter.placeholder} onChange={(event) => filter.onChange(event.target.value)} /></div> : null}
      <div className="sk-cat-items" onClickCapture={(event) => { if ((event.target as HTMLElement).closest('.sk-ci[data-opens-detail]')) shell.setCatalogStage('detail'); }}>{items}</div>
      {foot ? <div className="sk-cat-foot">{foot}</div> : null}
    </aside>
    <section className="sk-cat-detail">
      <div ref={scroller} className="sk-scroll" data-settings-page-scroll="">
        <div key={detailKey} data-settings-page="" className={cn('sk-page', 'enter', wideDetail && 'wide')}>{detail}</div>
      </div>
      {dock}
    </section>
  </div>;
}

export function CatalogItem({ selected, onSelect, lead, name, meta, end, pinned, dim, title, ariaLabel, opensDetail = true }: { selected: boolean; onSelect(): void; lead?: React.ReactNode; name: React.ReactNode; meta?: React.ReactNode; end?: React.ReactNode; pinned?: boolean; dim?: boolean; title?: string; ariaLabel?: string; opensDetail?: boolean }) {
  return <button type="button" className={cn('sk-ci', pinned && 'pinned', dim && 'dim')} aria-current={selected} aria-label={ariaLabel} title={title} data-opens-detail={opensDetail ? '' : undefined} onClick={onSelect}>
    {lead}
    <span className="sk-grow"><span className="sk-cn">{name}</span>{meta != null ? <span className="sk-cm">{meta}</span> : null}</span>
    {end != null ? <span className="sk-end">{end}</span> : null}
  </button>;
}
export function CatalogGroup({ label, count, action }: { label: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="sk-cg"><span>{label}</span>{action ?? (count != null ? <span>{count}</span> : null)}</div>;
}
export function Av({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return <span className={cn('sk-av', className)} style={style}>{children}</span>;
}

export function ObjectHeader({ avatar, title, chips, sub, actions }: { avatar?: React.ReactNode; title: React.ReactNode; chips?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="sk-oh2">
    {avatar}
    <div className="sk-ttl"><h1><span className="sk-name">{title}</span>{chips}</h1>{sub ? <div className="sk-sub">{sub}</div> : null}</div>
    {actions ? <div className="sk-acts">{actions}</div> : null}
  </div>;
}
export function Avatar({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span className="sk-avatar" style={style}>{children}</span>;
}

export function ObjectRow({ lead, title, description, end, onClick, top, item, className, children, expanded }: { lead?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; end?: React.ReactNode; onClick?(): void; top?: boolean; item?: string; className?: string; children?: React.ReactNode; expanded?: boolean }) {
  const interactive = Boolean(onClick);
  return <>
    <div data-settings-item={item} className={cn('sk-orow', interactive && 'click', top && 'top', className)}
      role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} aria-expanded={expanded}
      onClick={interactive ? (event) => { if ((event.target as HTMLElement).closest('button, a, input, textarea, [role="switch"], [role="listbox"]') && event.target !== event.currentTarget) return; onClick?.(); } : undefined}
      onKeyDown={interactive ? (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); onClick?.(); } } : undefined}>
      {lead}
      <div className="sk-grow"><div className="sk-ot">{title}</div>{description ? <div className="sk-od">{description}</div> : null}</div>
      {end != null ? <div className="sk-oe">{end}</div> : null}
    </div>
    {children}
  </>;
}
export function LeadIcon({ name }: { name: IconName }) {
  return <span className="sk-lead-ic"><Ic name={name} size="sm" /></span>;
}

export function Caps({ children }: { children: React.ReactNode }) { return <div className="sk-caps">{children}</div>; }
export function Cap({ children, use, onClick }: { children: React.ReactNode; use?: boolean; onClick?(): void }) {
  return onClick ? <button type="button" className={cn('sk-cap', use && 'use')} onClick={(event) => { event.stopPropagation(); onClick(); }}>{children}</button>
    : <span className={cn('sk-cap', use && 'use')}>{children}</span>;
}

export function Doc({ bar, children }: { bar: React.ReactNode; children: React.ReactNode }) {
  return <div className="sk-doc"><div className="sk-bar">{bar}</div>{children}</div>;
}

export function Tiles({ children, columns = 3 }: { children: React.ReactNode; columns?: number }) {
  return <div className="sk-tiles" style={{ '--n': columns } as React.CSSProperties}>{children}</div>;
}
export function Tile({ label, value, sub }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode }) {
  return <div className="sk-tile"><div className="sk-k">{label}</div><div className="sk-v">{value}</div>{sub ? <div className="sk-s">{sub}</div> : null}</div>;
}

export function After({ children }: { children: React.ReactNode }) { return <div className="sk-after">{children}</div>; }
export function FootNote({ children }: { children: React.ReactNode }) { return <p className="sk-foot-note">{children}</p>; }
