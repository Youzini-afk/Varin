import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import './question-controls.css';

/** Native inputs retain radio navigation and checkbox semantics; the row owns the presentation. */
export function QuestionChoices({ name, labelledBy, options, selected, multiple = false, disabled, onChange }: {
  name: string;
  labelledBy: string;
  options: readonly { id: string; label: string }[];
  selected: readonly string[];
  multiple?: boolean;
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  return <div className="question-choices" role={multiple ? 'group' : 'radiogroup'} aria-labelledby={labelledBy}>
    {options.map(option => {
      const checked = selected.includes(option.id);
      return <label key={option.id} className="question-choice" data-selected={checked} data-disabled={disabled || undefined}>
        <input type={multiple ? 'checkbox' : 'radio'} name={name} value={option.id} checked={checked} disabled={disabled}
          onChange={() => onChange(multiple ? checked ? selected.filter(id => id !== option.id) : [...selected, option.id] : [option.id])} />
        <span className="question-choice-mark" data-multiple={multiple} aria-hidden="true">{multiple ? <Icon name="check" /> : <span />}</span>
        <span className="question-choice-label">{option.label}</span>
      </label>;
    })}
  </div>;
}

/** Keep a collapsed answer mounted so reversing the animation never discards a draft. */
export function QuestionSupplement({ value, onChange, disabled, label, placeholder }: {
  value: string; onChange(value: string): void; disabled?: boolean; label?: string; placeholder?: string;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const [expanded, setExpanded] = React.useState<boolean>();
  const open = expanded ?? Boolean(value);
  const trigger = React.useRef<HTMLButtonElement>(null), input = React.useRef<HTMLTextAreaElement>(null);
  const focusInput = React.useRef(false);
  React.useLayoutEffect(() => {
    if (open && focusInput.current) input.current?.focus({ preventScroll: true });
    if (!open && document.activeElement === input.current) trigger.current?.focus({ preventScroll: true });
    focusInput.current = false;
  }, [open]);
  return <div className="question-supplement" data-open={open}>
    <button ref={trigger} type="button" className="question-supplement-toggle" disabled={disabled} aria-expanded={open} aria-controls={id}
      onClick={() => { focusInput.current = !open; setExpanded(!open); }}>
      <Icon name="arrow-right-s" aria-hidden="true" /><span>{label ?? t('ui.question.supplement')}</span>
      {!open && value && <span className="question-supplement-preview">{value}</span>}
    </button>
    <div id={id} className="question-supplement-reveal" aria-hidden={!open} inert={!open}>
      <div><textarea ref={input} className="question-text-input" rows={2} value={value} disabled={disabled}
        aria-label={label ?? t('ui.question.supplement')} placeholder={placeholder ?? t('ui.question.supplementPlaceholder')}
        onInput={event => onChange(event.currentTarget.value)} /></div>
    </div>
  </div>;
}
