import React from 'react';
import type { JsonObject } from '@varin/extension-contract';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';

import { eventConditionsValid, type EventConditionSchema as Schema } from './eventConditionSchema';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const schemaObject = (schema: unknown): JsonObject => object(schema) ? schema as JsonObject : {};

export function EventSourceConditions({ schema, value, disabled, onChange, onValidityChange }: {
  schema: Schema; value: Record<string, unknown>; disabled: boolean;
  onChange(value: Record<string, unknown>): void; onValidityChange(valid: boolean): void;
}) {
  const { t } = useI18n();
  const [errors, setErrors] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => { onValidityChange(!Object.values(errors).some(Boolean) && eventConditionsValid(schema, value)); }, [errors, schema, value, onValidityChange]);
  const properties = schemaObject(schema === true || schema === false ? undefined : schema.properties);
  if (!Object.keys(properties).length) {
    if (schema !== true && schema !== false && schema.additionalProperties === false) return null;
    return <JsonCondition label={t('arrangements.filter')} value={value} disabled={disabled}
      onChange={next => { if (object(next)) onChange(next); }} onValidityChange={onValidityChange} objectOnly />;
  }
  return <fieldset className="space-y-2"><legend>{t('arrangements.filter')}</legend>
    {Object.entries(properties).map(([key, definition]) => {
      const field = schemaObject(definition);
      const required = typeof schema === 'object' && Array.isArray(schema.required) && schema.required.includes(key);
      const label = `${typeof field.title === 'string' ? field.title : key}${required ? ' *' : ''}`;
      const change = (next: unknown) => { const result = { ...value }; if (next === undefined) delete result[key]; else result[key] = next; onChange(result); };
      const type = field.type;
      let input: React.ReactNode;
      if (Array.isArray(field.enum)) input = <select aria-label={label} disabled={disabled} value={value[key] === undefined ? '' : JSON.stringify(value[key])}
        onChange={event => change(event.target.value ? JSON.parse(event.target.value) : undefined)}><option value="">{t('arrangements.unspecified')}</option>
        {field.enum.map((option, index) => <option key={index} value={JSON.stringify(option)}>{typeof option === 'string' ? option : JSON.stringify(option)}</option>)}</select>;
      else if (type === 'boolean') input = <select aria-label={label} disabled={disabled} value={value[key] === undefined ? '' : String(value[key])}
        onChange={event => change(event.target.value ? event.target.value === 'true' : undefined)}><option value="">{t('arrangements.unspecified')}</option><option value="true">{t('arrangements.yes')}</option><option value="false">{t('arrangements.no')}</option></select>;
      else if (type === 'string' || type === 'number' || type === 'integer') input = <Input aria-label={label} disabled={disabled} value={String(value[key] ?? '')}
        type={type === 'string' ? 'text' : 'number'} min={typeof field.minimum === 'number' ? field.minimum : undefined} max={typeof field.maximum === 'number' ? field.maximum : undefined}
        step={type === 'integer' ? 1 : 'any'} onChange={event => change(event.target.value === '' ? undefined : type === 'string' ? event.target.value : Number(event.target.value))} />;
      else input = <JsonCondition label={label} value={value[key]} disabled={disabled} onChange={change}
        onValidityChange={valid => setErrors(previous => previous[key] === !valid ? previous : { ...previous, [key]: !valid })} />;
      return <div key={key} className="space-y-1"><label className="block">{label}{input}</label>{typeof field.description === 'string' && <p className="text-xs text-muted-foreground">{field.description}</p>}</div>;
    })}
  </fieldset>;
}

function JsonCondition({ label, value, disabled, onChange, onValidityChange, objectOnly = false }: {
  label: string; value: unknown; disabled: boolean; objectOnly?: boolean; onChange(value: unknown): void; onValidityChange(valid: boolean): void;
}) {
  const { t } = useI18n();
  const [text, setText] = React.useState(() => value === undefined ? '' : JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = React.useState(false);
  return <><Textarea aria-label={label} value={text} disabled={disabled} rows={2} onChange={event => {
    const next = event.target.value; setText(next);
    try { const parsed: unknown = next.trim() ? JSON.parse(next) : undefined; if (objectOnly && !object(parsed)) throw new Error();
      onChange(parsed); setInvalid(false); onValidityChange(true);
    } catch { setInvalid(true); onValidityChange(false); }
  }} />{invalid && <p role="alert">{t('arrangements.filterInvalid')}</p>}</>;
}
