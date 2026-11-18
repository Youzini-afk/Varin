/* Settings kit · controls. Each mirrors a control in docs/design/settings-preview/kit.js. */
import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type IcSize = 'xs' | 'sm' | 'md' | 'lg';
export function Ic({ name, size = 'md', className }: { name: IconName; size?: IcSize; className?: string }) {
  return <Icon name={name} aria-hidden className={cn('sk-ic', size !== 'md' && size, className)} />;
}

/** Hover hint; touch opens it on tap. Renders the child unchanged without text. */
export function Tip({ text, children, side }: { text?: React.ReactNode; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!text) return children;
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent side={side} sideOffset={6} className="max-w-xs">{text}</TooltipContent></Tooltip>;
}

export type BtnKind = 'default' | 'primary' | 'ghost' | 'danger' | 'ghost-danger';
export interface BtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  kind?: BtnKind;
  sm?: boolean;
  icon?: IconName;
  tip?: React.ReactNode;
  busy?: boolean;
  children?: React.ReactNode;
}
export const Btn = React.forwardRef<HTMLButtonElement, BtnProps>(function Btn({ kind = 'default', sm, icon, tip, busy, children, className, type = 'button', ...rest }, ref) {
  const iconOnly = children == null || children === false;
  const label = iconOnly && typeof tip === 'string' ? tip : undefined;
  const button = <button ref={ref} type={type} aria-label={label ?? rest['aria-label']} {...rest}
    className={cn('sk-btn', kind === 'primary' && 'primary', (kind === 'ghost' || kind === 'ghost-danger') && 'ghost', (kind === 'danger' || kind === 'ghost-danger') && 'danger', sm && 'sm', iconOnly && 'icon', className)}>
    {busy ? <span className="sk-spin" /> : icon ? <Ic name={icon} size="sm" /> : null}{children}
  </button>;
  return <Tip text={tip}>{button}</Tip>;
});

export function Sw({ checked, onChange, label, disabled, className }: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean; className?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={cn('sk-sw', className)} onClick={(event) => { event.stopPropagation(); onChange(!checked); }} />;
}

export function Dot({ state = 'ok', tip }: { state?: 'ok' | 'warn' | 'err' | 'off' | 'idle'; tip?: string }) {
  const dot = <span className={cn('sk-dot', state !== 'idle' && state)} aria-label={tip} role={tip ? 'img' : undefined} />;
  return tip ? <Tip text={tip}>{dot}</Tip> : dot;
}

export function Chip({ kind, icon, tiny, children, className, title }: { kind?: 'ok' | 'warn' | 'err' | 'primary' | 'plain'; icon?: IconName; tiny?: boolean; children: React.ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('sk-chip', kind, tiny && 'tiny', className)}>{icon ? <Ic name={icon} size="xs" /> : null}{children}</span>;
}

export function Kbd({ keys }: { keys: string }) {
  return <span className="sk-hstack" style={{ gap: 4 }}>{keys.split('+').map((key, index) => <span key={index} className="sk-kbd">{key}</span>)}</span>;
}

export function Info({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild>
      <button type="button" className="sk-info" aria-label={t('settings.common.infoAria')} aria-expanded={open}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value); }}>
        <Ic name="information" size="xs" />
      </button>
    </TooltipTrigger>
    <TooltipContent sideOffset={6} className="max-w-sm">{children}</TooltipContent>
  </Tooltip>;
}

/* ── Segmented control with a sliding thumb ── */
export interface SegOption<T extends string> { value: T; label: React.ReactNode; icon?: IconName; disabled?: boolean; title?: string }
export function Seg<T extends string>({ value, options, onChange, label, disabled, className }: { value: T; options: readonly SegOption<T>[]; onChange(value: T): void; label?: string; disabled?: boolean; className?: string }) {
  const root = React.useRef<HTMLDivElement>(null);
  const thumb = React.useRef<HTMLSpanElement>(null);
  const place = React.useCallback(() => {
    const node = root.current; const marker = thumb.current;
    if (!node || !marker) return;
    const active = node.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!active) { marker.style.width = '0'; return; }
    marker.style.left = `${active.offsetLeft}px`;
    marker.style.width = `${active.offsetWidth}px`;
  }, []);
  React.useLayoutEffect(place, [place, value, options]);
  React.useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => observer.disconnect();
  }, [place]);
  return <div ref={root} className={cn('sk-seg', className)} role="radiogroup" aria-label={label} onKeyDown={(event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const enabled = options.filter(option => !option.disabled);
    const index = enabled.findIndex(option => option.value === value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault(); onChange(next.value);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus());
  }}>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} aria-pressed={option.value === value}
      tabIndex={option.value === value ? 0 : -1} title={option.title} disabled={disabled || option.disabled}
      onClick={() => { if (option.value !== value) onChange(option.value); }}>
      {option.icon ? <Ic name={option.icon} size="sm" /> : null}{option.label}
    </button>)}
    <span ref={thumb} className="sk-thumb" aria-hidden />
  </div>;
}

/* ── Select: grouped options, logos, descriptions, keyboard navigation ── */
export type SelectItem<T extends string> =
  | { value: T; label: React.ReactNode; text?: string; short?: React.ReactNode; description?: React.ReactNode; icon?: IconName; logo?: React.ReactNode; meta?: React.ReactNode; disabled?: boolean }
  | { group: React.ReactNode; key?: string }
  | { separator: true; key?: string };
type SelectOptionItem<T extends string> = Extract<SelectItem<T>, { value: T }>;
const isOption = <T extends string>(item: SelectItem<T>): item is SelectOptionItem<T> => 'value' in item;
export type SelectWidth = 'w' | 'wl' | 'ws' | 'wf' | 'auto';

export interface SelectProps<T extends string> {
  value: T | null | undefined;
  options: readonly SelectItem<T>[];
  onChange(value: T): void;
  width?: SelectWidth;
  plain?: boolean;
  placeholder?: React.ReactNode;
  label?: string;
  disabled?: boolean;
  className?: string;
  /** Rendered after the options (for example "import…" actions). */
  footer?: (close: () => void) => React.ReactNode;
  emptyText?: React.ReactNode;
  onOpenChange?(open: boolean): void;
  trailing?: React.ReactNode;
}

export function Select<T extends string>({ value, options, onChange, width = 'w', plain, placeholder, label, disabled, className, footer, emptyText, onOpenChange, trailing }: SelectProps<T>) {
  const [open, setOpenState] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const pop = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const flat = React.useMemo(() => options.filter(isOption), [options]);
  const current = flat.find(option => option.value === value);
  const setOpen = React.useCallback((next: boolean) => { setOpenState(next); onOpenChange?.(next); }, [onOpenChange]);
  const close = React.useCallback(() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }, [setOpen]);

  React.useLayoutEffect(() => {
    if (!open) return;
    const node = pop.current; const anchor = trigger.current;
    if (!node || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const above = rect.top - 12; const below = window.innerHeight - rect.bottom - 12;
    node.style.minWidth = `${Math.min(Math.max(rect.width, 200), window.innerWidth - 16)}px`;
    node.style.maxHeight = '';
    const height = node.offsetHeight;
    const openAbove = height > below && above > below;
    node.style.maxHeight = `${Math.min(height, Math.max(120, openAbove ? above : below))}px`;
    node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${openAbove ? rect.top - node.offsetHeight - 4 : rect.bottom + 4}px`;
    node.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pop.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    const dismiss = (event: Event) => { if (!pop.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true); };
  }, [open, setOpen]);

  const choose = (option: SelectOptionItem<T>) => {
    if (option.disabled) return;
    close();
    if (option.value !== value) onChange(option.value);
  };
  const move = (step: number) => {
    if (!flat.length) return;
    let index = active;
    for (let i = 0; i < flat.length; i += 1) {
      index = (index + step + flat.length) % flat.length;
      if (!flat[index]?.disabled) break;
    }
    setActive(index);
    pop.current?.querySelectorAll<HTMLElement>('.sk-opt')[index]?.scrollIntoView({ block: 'nearest' });
  };
  const openWith = (index?: number) => { setActive(index ?? flat.findIndex(option => option.value === value)); setOpen(true); };

  const lead = current?.logo ?? (current?.icon ? <Ic name={current.icon} size="sm" /> : null);
  let optionIndex = -1;
  return <>
    <button ref={trigger} type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-label={label ? `${label}${current?.text ? ` · ${current.text}` : ''}` : undefined}
      className={cn('sk-dd', width !== 'auto' && width, plain && 'plain', className)}
      onClick={() => (open ? setOpen(false) : openWith())}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openWith(); }
      }}>
      {lead}
      <span className={cn('sk-lbl', !current && 'ph')}>{current ? current.short ?? current.label : placeholder ?? ''}</span>
      {current?.meta ? <span className="sk-via">{current.meta}</span> : null}
      {trailing}
      <Ic name="expand-up-down" size="xs" className="sk-chev" />
    </button>
    {open ? createPortal(<div ref={pop} id={listId} role="listbox" tabIndex={-1} aria-label={label} className="sk-layer sk-pop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        else if (event.key === 'Home') { event.preventDefault(); setActive(-1); move(1); }
        else if (event.key === 'End') { event.preventDefault(); setActive(flat.length); move(-1); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const option = flat[active]; if (option) choose(option); }
        else if (event.key === 'Tab') setOpen(false);
      }}>
      {flat.length === 0 && emptyText ? <div className="sk-empty-opt">{emptyText}</div> : null}
      {options.map((item, index) => {
        if ('separator' in item) return <div key={item.key ?? `sep-${index}`} className="sk-sep" role="separator" />;
        if ('group' in item) return <div key={item.key ?? `grp-${index}`} className="sk-grp" role="presentation">{item.group}</div>;
        optionIndex += 1;
        const own = optionIndex;
        return <button key={item.value} type="button" role="option" aria-selected={item.value === value} aria-disabled={item.disabled || undefined}
          className={cn('sk-opt', own === active && 'kb')} onMouseMove={() => setActive(own)} onClick={() => choose(item)}>
          {item.logo ?? (item.icon ? <Ic name={item.icon} size="sm" /> : null)}
          <span className="sk-grow">{item.label}{item.description ? <small>{item.description}</small> : null}</span>
          {item.meta ? <small className="sk-via">{item.meta}</small> : null}
          <Ic name="check" size="sm" className="sk-chk" />
        </button>;
      })}
      {footer ? <>{flat.length ? <div className="sk-sep" /> : null}{footer(close)}</> : null}
    </div>, document.body) : null}
  </>;
}

/* ── Inputs ── */
export type FieldWidth = 'w' | 'wl' | 'ws' | 'wf' | 'wn' | 'auto';
export interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width'> { width?: FieldWidth; mono?: boolean; invalid?: boolean }
export const Field = React.forwardRef<HTMLInputElement, FieldProps>(function Field({ width = 'w', mono, invalid, className, ...rest }, ref) {
  return <input ref={ref} spellCheck={false} autoComplete="off" aria-invalid={invalid || undefined} {...rest}
    className={cn('sk-field', width !== 'w' && width !== 'auto' && width, mono && 'sk-mono', className)} />;
});

/** Text input that keeps a local draft and commits on blur or Enter. */
export function CommitField({ value, onCommit, ...rest }: Omit<FieldProps, 'value' | 'onChange'> & { value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = React.useState(value);
  const editing = React.useRef(false);
  React.useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  const commit = () => { editing.current = false; if (draft !== value) onCommit(draft); };
  return <Field {...rest} value={draft} onFocus={(event) => { editing.current = true; rest.onFocus?.(event); }}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') { event.currentTarget.blur(); } if (event.key === 'Escape') { editing.current = false; setDraft(value); event.currentTarget.blur(); } rest.onKeyDown?.(event); }} />;
}

export interface NumFieldProps { value: number | null | undefined; onCommit(value: number | null): void; unit?: React.ReactNode; placeholder?: string; min?: number; max?: number; step?: number; integer?: boolean; disabled?: boolean; label?: string; width?: FieldWidth; allowEmpty?: boolean }
/** Number entry with a unit. Empty input means "unset" only when allowEmpty. Out-of-range values clamp on commit. */
export function NumField({ value, onCommit, unit, placeholder, min, max, integer, disabled, label, width = 'wn', allowEmpty }: NumFieldProps) {
  const text = value == null || Number.isNaN(value) ? '' : String(value);
  const [draft, setDraft] = React.useState(text);
  const editing = React.useRef(false);
  React.useEffect(() => { if (!editing.current) setDraft(text); }, [text]);
  const commit = () => {
    editing.current = false;
    const trimmed = draft.trim();
    if (!trimmed) { if (allowEmpty) { if (value != null) onCommit(null); } else setDraft(text); return; }
    let next = Number(trimmed);
    if (!Number.isFinite(next)) { setDraft(text); return; }
    if (integer) next = Math.round(next);
    if (min != null) next = Math.max(min, next);
    if (max != null) next = Math.min(max, next);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <span className="sk-numf">
    <Field width={width} inputMode="decimal" value={draft} placeholder={placeholder} disabled={disabled} aria-label={label}
      onFocus={() => { editing.current = true; }} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { editing.current = false; setDraft(text); event.currentTarget.blur(); }
      }} />
    {unit ? <span className="sk-unit">{unit}</span> : null}
  </span>;
}

export const Area = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Area({ mono, className, ...rest }, ref) {
  return <textarea ref={ref} spellCheck={false} {...rest} className={cn('sk-area', mono && 'sk-mono', className)} />;
});

export function Tags({ value, onChange, placeholder, label, disabled, validate }: { value: readonly string[]; onChange(next: string[]): void; placeholder?: string; label?: string; disabled?: boolean; validate?(entry: string): boolean }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  const add = () => {
    const entries = draft.split(/[\n,]/).map(entry => entry.trim()).filter(Boolean).filter(entry => !value.includes(entry)).filter(entry => validate?.(entry) ?? true);
    if (entries.length) onChange([...value, ...entries]);
    setDraft('');
  };
  return <div className="sk-tags" aria-label={label}>
    {value.map((entry, index) => <span key={`${entry}-${index}`} className="sk-tag"><span title={entry}>{entry}</span>
      {disabled ? null : <button type="button" aria-label={t('settings.kit.removeTag', { value: entry })} onClick={() => onChange(value.filter((_, i) => i !== index))}><Ic name="close" size="xs" /></button>}
    </span>)}
    {disabled ? null : <input value={draft} placeholder={placeholder ?? t('settings.kit.tagPlaceholder')} aria-label={label}
      onChange={(event) => setDraft(event.target.value)} onBlur={add}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); }
        else if (event.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
      }} />}
  </div>;
}

export function Range({ value, onChange, onCommit, min, max, step, format, label, disabled }: { value: number; onChange?(value: number): void; onCommit?(value: number): void; min: number; max: number; step: number; format(value: number): string; label: string; disabled?: boolean }) {
  const [live, setLive] = React.useState(value);
  React.useEffect(() => setLive(value), [value]);
  return <span className="sk-rangef">
    <input type="range" className="sk-range" min={min} max={max} step={step} value={live} aria-label={label} disabled={disabled}
      onChange={(event) => { const next = Number(event.target.value); setLive(next); onChange?.(next); }}
      onPointerUp={() => onCommit?.(live)} onKeyUp={() => onCommit?.(live)} onBlur={() => { if (live !== value) onCommit?.(live); }} />
    <span className="sk-rv">{format(live)}</span>
  </span>;
}

export function Logo({ children, size }: { children: React.ReactNode; size?: 'md' | 'lg' }) {
  return <span className={cn('sk-logo', size)}>{children}</span>;
}
