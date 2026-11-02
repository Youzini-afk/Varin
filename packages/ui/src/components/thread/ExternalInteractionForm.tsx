import React from 'react';
import { isExternalInteractionValueValid, type ExternalInteraction, type ExternalInteractionField, type ExternalInteractionResponse } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

type Value = string | number | boolean | string[];
function InteractionField({ field, value, disabled, onChange }: {
  field: ExternalInteractionField; value: Value | undefined; disabled: boolean; onChange(value: Value | undefined): void;
}) {
  const id = React.useId();
  const { t } = useI18n();
  const shared = { id, disabled, 'aria-label': field.label, 'aria-describedby': `${id}-description`, className: 'w-full rounded-lg border border-border bg-background p-2 typography-meta' };
  return <div className="space-y-1">
    <label htmlFor={id} className="typography-meta font-medium">{field.label}{field.required ? ' *' : ''}</label>
    {field.type === 'boolean' ? <select {...shared} value={value === undefined ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}>
      <option value="">{t('external.chooseValue')}</option><option value="true">{t('external.yes')}</option><option value="false">{t('external.no')}</option>
    </select> : field.type === 'select' ? <select {...shared} value={value === undefined ? '' : `value:${value}`} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value.slice(6))}>
      <option value="">{t('external.chooseValue')}</option>{field.options?.map(option => <option key={option.value} value={`value:${option.value}`}>{option.label}</option>)}
    </select> : field.type === 'multiselect' ? <div role="group" aria-label={field.label}>
      {field.options?.map(option => <label key={option.value} className="mr-3 inline-flex gap-1">
        <input type="checkbox" disabled={disabled} checked={Array.isArray(value) && value.includes(option.value)} onChange={event => {
          const values = Array.isArray(value) ? value : [];
          onChange(event.target.checked ? [...values, option.value] : values.filter(item => item !== option.value));
        }} />{option.label}
      </label>)}
    </div> : <input {...shared} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? field.integer ? 1 : 'any' : undefined}
      min={field.minimum} max={field.maximum}
      value={value === undefined ? '' : String(value)} onChange={event => onChange(event.target.value)} />}
    <p id={`${id}-description`} className="whitespace-pre-wrap typography-meta text-muted-foreground">{field.description}
      {field.integer && ` ${t('external.integerField')}`}
      {field.minimum !== undefined && ` ${t('external.minimumField', { value: field.minimum })}`}
      {field.maximum !== undefined && ` ${t('external.maximumField', { value: field.maximum })}`}
      {field.minLength !== undefined && ` ${t('external.minLengthField', { value: field.minLength })}`}
      {field.maxLength !== undefined && ` ${t('external.maxLengthField', { value: field.maxLength })}`}
      {field.minItems !== undefined && ` ${t('external.minItemsField', { value: field.minItems })}`}
      {field.maxItems !== undefined && ` ${t('external.maxItemsField', { value: field.maxItems })}`}
    </p>
  </div>;
}
export function ExternalInteractionForm({
  request,
  pending,
  respond,
}: {
  request: ExternalInteraction;
  pending: boolean;
  respond(value: ExternalInteractionResponse): void;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({});
  const [free, setFree] = React.useState<Record<string, string>>({});
  const [value, setValue] = React.useState('');
  const [values, setValues] = React.useState<Record<string, string | number | boolean | string[] | undefined>>(() =>
    Object.fromEntries((request.fields ?? []).map(field => [field.id, field.defaultValue])));
  const [error, setError] = React.useState('');
  return (
    <section
      className="mb-3 max-h-[50vh] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg"
      aria-label={request.title}
    >
      <p className="mb-3 font-medium">{request.title}</p>
      {request.detail && (
        <pre className="mb-3 whitespace-pre-wrap break-all typography-meta text-muted-foreground">
          {request.detail}
        </pre>
      )}
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const fields: NonNullable<ExternalInteractionResponse['values']> = {};
          for (const field of request.fields ?? []) {
            const raw = values[field.id];
            if (raw === undefined || field.type === 'number' && raw === '') {
              if (field.required) { setError(t('external.requiredField', { name: field.label })); return; }
              continue;
            }
            const value = field.type === 'number' ? Number(raw) : raw;
            if (!isExternalInteractionValueValid(field, value)) { setError(t('external.invalidField', { name: field.label })); return; }
            fields[field.id] = value;
          }
          setError('');
          respond({
            ...(request.fields ? { values: fields } : {}),
            answers: Object.fromEntries(
              (request.questions ?? []).map((q) => [
                q.id,
                [...(answers[q.id] ?? []), ...(free[q.id]?.trim() ? [free[q.id]!] : [])],
              ]),
            ),
            text: value,
          });
        }}
      >
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {request.fields?.map(field => <InteractionField key={field.id} field={field} value={values[field.id]} disabled={pending}
          onChange={value => setValues(old => ({ ...old, [field.id]: value }))} />)}
        {request.questions?.map((q) => (
          <fieldset key={q.id} className="space-y-2">
            <legend className="mb-2 typography-meta font-medium">{q.question}</legend>
            {q.options?.map((option) => (
              <label
                key={option.label}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3 typography-meta hover:bg-muted"
              >
                <input
                  className="mt-1 shrink-0 accent-[var(--primary)]"
                  type={q.multiple ? 'checkbox' : 'radio'}
                  name={q.id}
                  disabled={pending}
                  checked={answers[q.id]?.includes(option.label) ?? false}
                  onChange={(event) =>
                    setAnswers((old) => ({
                      ...old,
                      [q.id]: q.multiple
                        ? event.target.checked
                          ? [...(old[q.id] ?? []), option.label]
                          : (old[q.id] ?? []).filter((v) => v !== option.label)
                        : [option.label],
                    }))
                  }
                />
                <span className="min-w-0 break-words">
                  {option.label}
                  {option.description && (
                    <span className="mt-1 block text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
            <textarea
              className="min-h-16 w-full rounded-lg border border-border bg-background p-3 typography-meta"
              aria-label={`${q.question} · ${t('external.answer')}`}
              disabled={pending}
              value={free[q.id] ?? ''}
              onChange={(event) => setFree((old) => ({ ...old, [q.id]: event.target.value }))}
            />
          </fieldset>
        ))}
        {request.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => respond({ optionId: option.id })}
            className="mr-2 whitespace-normal text-left"
          >
            {option.label}
          </Button>
        ))}
        {!request.options.length && !request.questions?.length && !request.fields?.length && (
          <textarea
            className="min-h-20 w-full rounded-lg border border-border bg-background p-3"
            aria-label={t('external.answer')}
            disabled={pending}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        {!request.options.length && (
          <Button type="submit" disabled={pending}>
            {t('external.confirm')}
          </Button>
        )}
        <Button type="button" variant="ghost" disabled={pending} onClick={() => respond({ cancelled: true })}>{t('external.cancelInteraction')}</Button>
      </form>
    </section>
  );
}
