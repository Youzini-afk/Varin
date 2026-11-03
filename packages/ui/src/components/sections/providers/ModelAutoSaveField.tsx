import React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ModelCatalogField } from '@varin/application-client';
import { ModelFieldContext } from './model-field-context';

type Props = Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string; onCommit(value: string): void; validate?(value: string): string | null;
  multiline?: boolean; rows?: number;
  catalogField?: ModelCatalogField;
};

/** Unfinished or invalid text stays in the field; only complete values reach the save queue. */
export function ModelAutoSaveField({ value, onCommit, validate, multiline, rows, catalogField, onBlur, onKeyDown, ...props }: Props) {
  const [draft, setDraft] = React.useState(value);
  const [issue, setIssue] = React.useState<string | null>(null);
  const state = React.useRef({ draft: value, dirty: false, onCommit, validate });
  state.current.onCommit = onCommit; state.current.validate = validate;
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const issueId = React.useId();
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
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { commit(); onBlur?.(event as React.FocusEvent<HTMLInputElement>); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
      onKeyDown?.(event as React.KeyboardEvent<HTMLInputElement>);
    },
  };
  return <div className="min-w-0 flex-1">
    {multiline ? <Textarea {...props as React.ComponentProps<typeof Textarea>} {...events} rows={rows ?? 4} value={draft} aria-invalid={Boolean(issue)} aria-describedby={issue ? issueId : props['aria-describedby']} />
      : <Input {...props} {...events} value={draft} aria-invalid={Boolean(issue)} aria-describedby={issue ? issueId : props['aria-describedby']} />}
    {issue ? <p id={issueId} role="alert" className="mt-1 typography-micro text-destructive">{issue}</p> : null}
  </div>;
}
