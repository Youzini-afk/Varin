import React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ModelCatalogField } from '@varin/application-client';
import { ModelFieldContext } from './model-field-context';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

type Props = Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string; onCommit(value: string): void; validate?(value: string): string | null;
  multiline?: boolean; rows?: number;
  catalogField?: ModelCatalogField;
  presets?: readonly { value: string; label: string; detail?: string }[];
};

/** Unfinished or invalid text stays in the field; only complete values reach the save queue. */
export function ModelAutoSaveField({ value, onCommit, validate, multiline, rows, catalogField, presets, onBlur, onKeyDown, ...props }: Props) {
  const [draft, setDraft] = React.useState(value);
  const [issue, setIssue] = React.useState<string | null>(null);
  const state = React.useRef({ draft: value, dirty: false, onCommit, validate });
  state.current.onCommit = onCommit; state.current.validate = validate;
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const issueId = React.useId();
  const field = React.useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [menuWidth, setMenuWidth] = React.useState<number>();
  const fields = React.useContext(ModelFieldContext);
  const restoration = catalogField ? fields?.restored[catalogField] : undefined;
  const previousRestoration = React.useRef(restoration);
  const commit = React.useCallback(() => {
    clearTimeout(timer.current);
    const current = state.current;
    if (!current.dirty) return;
    const error = current.validate?.(current.draft) ?? null;
    setIssue(error);
    if (error) return;
    current.dirty = false; current.onCommit(current.draft);
  }, []);
  const openMenu = (open: boolean) => {
    if (open) { setMenuWidth(field.current?.getBoundingClientRect().width); clearTimeout(timer.current); }
    else commit();
    setMenuOpen(open);
  };
  React.useEffect(() => {
    if (previousRestoration.current !== restoration) {
      previousRestoration.current = restoration;
      state.current.dirty = false; clearTimeout(timer.current);
    }
    if (!state.current.dirty) { state.current.draft = value; setDraft(value); setIssue(null); }
  }, [value, restoration]);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const events = {
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      state.current.draft = event.target.value; state.current.dirty = true;
      setDraft(event.target.value); setIssue(null); clearTimeout(timer.current);
      if (!(event.nativeEvent as InputEvent).isComposing) timer.current = setTimeout(commit, 650);
    },
    onCompositionEnd: () => { clearTimeout(timer.current); timer.current = setTimeout(commit, 650); },
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (!menuOpen) commit(); onBlur?.(event as React.FocusEvent<HTMLInputElement>); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (presets && event.key === 'ArrowDown' && !event.nativeEvent.isComposing) { event.preventDefault(); openMenu(true); }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
      onKeyDown?.(event as React.KeyboardEvent<HTMLInputElement>);
    },
  };
  return <div ref={field} className="relative min-w-0 flex-1">
    {multiline ? <Textarea {...props as React.ComponentProps<typeof Textarea>} {...events} rows={rows ?? 4} value={draft} aria-invalid={Boolean(issue)} aria-describedby={issue ? issueId : props['aria-describedby']} />
      : <Input {...props} {...events} className={cn(props.className, presets && 'pr-10 tabular-nums')} value={draft} aria-invalid={Boolean(issue)} aria-describedby={issue ? issueId : props['aria-describedby']} />}
    {presets && <DropdownMenu open={menuOpen} onOpenChange={openMenu}>
      <DropdownMenuTrigger asChild><button type="button" disabled={props.disabled} aria-label={props['aria-label']}
        className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-item text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        <Icon name="arrow-down-s" className="size-4" />
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" style={{ width: menuWidth, maxWidth: 'calc(100vw - 2rem)' }}>
        {presets.map(option => <DropdownMenuItem key={option.value} onSelect={() => {
          state.current.draft = option.value; state.current.dirty = true; setDraft(option.value); setIssue(null); commit();
        }}>
          <span className="flex-1">{option.label}</span>
          {option.detail && <span className="typography-micro tabular-nums text-muted-foreground">{option.detail}</span>}
          <Icon name="check" className={cn('size-3.5', value !== option.value && 'invisible')} />
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>}
    {issue ? <p id={issueId} role="alert" className="mt-1 typography-micro text-destructive">{issue}</p> : null}
  </div>;
}
