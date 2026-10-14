import React from 'react';
import type { JsonValue } from '@varin/protocol';
import { Textarea } from '@/components/ui/textarea';

/** Keeps an unfinished JSON edit local while the parent retains the last valid object. */
export function JsonObjectField({ value, label, disabled, onChange, onValidityChange }: {
  value?: Record<string, JsonValue>;
  label: string;
  disabled?: boolean;
  onChange(value: Record<string, JsonValue> | undefined): void;
  onValidityChange?(valid: boolean): void;
}) {
  const encoded = value === undefined ? '' : JSON.stringify(value);
  const [draft, setDraft] = React.useState(() => value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = React.useState(false);
  const published = React.useRef(encoded);
  React.useEffect(() => {
    if (encoded === published.current) return;
    published.current = encoded; setDraft(value === undefined ? '' : JSON.stringify(value, null, 2)); setError(false); onValidityChange?.(true);
  }, [encoded, value, onValidityChange]);
  return <Textarea aria-label={label} aria-invalid={error} disabled={disabled} className="font-mono typography-micro" placeholder="{}" value={draft} onChange={event => {
    const content = event.target.value; setDraft(content);
    try {
      const next: unknown = content.trim() ? JSON.parse(content) : undefined;
      if (next !== undefined && (!next || typeof next !== 'object' || Array.isArray(next))) throw new Error('Expected an object');
      published.current = next === undefined ? '' : JSON.stringify(next); setError(false); onValidityChange?.(true);
      onChange(next as Record<string, JsonValue> | undefined);
    } catch { setError(true); onValidityChange?.(false); }
  }} />;
}
