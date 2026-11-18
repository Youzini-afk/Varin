import React from 'react';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { cn } from '@/lib/utils';
import { Info, Section, Seg, Sw } from './kit';

/** Settings select trigger: full column width in stacked cells; capped in field rows via parent. */
export const SETTINGS_SELECT_TRIGGER_CLASS = 'w-full min-w-40 max-w-48';
export const SETTINGS_SELECT_SIZE = 'settings' as const;

/** Fixed-width select used inside full-width SettingsFieldRow control columns. */
export const SETTINGS_SELECT_ROW_TRIGGER_CLASS = 'w-full min-w-40 max-w-48';

/** Compact reset / icon action next to a settings control (matches h-8 controls). */
export const SETTINGS_ICON_BUTTON_CLASS =
  'h-8 w-8 px-0 text-muted-foreground hover:text-foreground';

/** Custom dropdown triggers (ModelSelector / AgentSelector) in settings field rows. */
// eslint-disable-next-line react-refresh/only-export-components
export const SETTINGS_CUSTOM_TRIGGER_CLASS = cn(
  dropdownTriggerVariants(),
  'w-full min-w-40 max-w-48',
);

/** Shared width for stacked control clusters (select/input + reset). */
export const SETTINGS_CONTROL_CLUSTER_CLASS = 'w-full max-w-[24rem]';

/** Fill a control cluster the same way as a full-width select. */
export const SETTINGS_CLUSTER_CONTROL_CLASS = 'min-w-0 flex-1';

/**
 * Row wrapping a NumberInput + unit label + reset.
 * Keep the stepper intrinsic — never flex-grow it or +/- buttons stretch unevenly.
 */
export const SETTINGS_NUMBER_STEPPER_ROW_CLASS = 'flex w-full min-w-0 items-center gap-2';

/** Unit suffix next to a settings number stepper (%, px, …). */
export const SETTINGS_NUMBER_UNIT_CLASS =
  'typography-meta shrink-0 text-muted-foreground tabular-nums';

/** Vertical stack spacing for fields inside a column. */
export const SETTINGS_FIELDS_STACK_CLASS = 'space-y-4';

/** Compact checkbox / radio list stack. */
export const SETTINGS_OPTION_STACK_CLASS = 'space-y-1.5';

/**
 * Settings heading classes by context (size + default color).
 * Prefer these over ad-hoc typography-* + color combinations.
 */
/** L1 — page / detail-pane title (larger, quieter than section titles). */
export const SETTINGS_PAGE_TITLE_CLASS =
  'typography-settings-page-title font-semibold tracking-tight text-foreground';
/** L2 — section title inside a settings page. */
export const SETTINGS_SECTION_TITLE_CLASS =
  'typography-settings-section-title text-foreground';
/** Split-pane sidebar panel title — same level as section titles. */
export const SETTINGS_PANEL_TITLE_CLASS = SETTINGS_SECTION_TITLE_CLASS;
/** L3 — control-group heading inside a section. */
export const SETTINGS_GROUP_TITLE_CLASS =
  'typography-settings-group-title text-foreground';
/** L4 — field / control labels. */
export const SETTINGS_FIELD_LABEL_CLASS =
  'typography-settings-field-label text-foreground';
/** Supporting copy under page or section titles. */
export const SETTINGS_DESCRIPTION_CLASS =
  'typography-settings-description text-muted-foreground';
/** Supporting copy under group titles and fields. */
export const SETTINGS_HELPER_CLASS = 'typography-meta text-muted-foreground';
/** Callout / alert headline inside a section (not a control-group title). */
export const SETTINGS_CALLOUT_TITLE_CLASS = 'typography-meta font-medium text-foreground';
/** Brand / product name under a logo — quieter than L1 page title. */
export const SETTINGS_BRAND_TITLE_CLASS =
  'typography-settings-section-title text-foreground';

interface SettingsSectionProps {
  /** Section title. Strings render as the shared h2 style. */
  title?: React.ReactNode;
  /** Optional supporting text under the title. */
  description?: React.ReactNode;
  /** Optional icon/badge next to the title. */
  titleAccessory?: React.ReactNode;
  /** Helper text hidden behind an info icon next to the title. */
  info?: React.ReactNode;
  /** Optional action aligned to the right of the header. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  /** Kept for callers; sections are separated by spacing, not rules. */
  divider?: boolean;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
  /** Render content without the grouped panel (cards, tables, custom layouts). */
  raw?: boolean;
  after?: React.ReactNode;
}

/** A titled section whose rows sit in one grouped panel. */
export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title, description, titleAccessory, info, headerAction, children, className, contentClassName, settingsItem, raw, after,
}) => (
  <Section
    item={settingsItem}
    className={className}
    title={title}
    titleAccessory={<>{titleAccessory}{info != null ? <Info>{info}</Info> : null}</>}
    description={description}
    actions={headerAction}
    raw={raw}
    panelClassName={contentClassName}
    after={after}
  >{children}</Section>
);

interface SettingsTwoColumnProps {
  children: React.ReactNode;
  className?: string;
}

/** Responsive two-column settings grid used when space allows. */
export const SettingsTwoColumn: React.FC<SettingsTwoColumnProps> = ({ children, className }) => (
  <div className={cn('sk-row-group grid grid-cols-1 @3xl:grid-cols-2', className)}>{children}</div>
);

interface SettingsGroupTitleProps {
  children: React.ReactNode;
  className?: string;
  as?: 'h2' | 'h3' | 'div';
}

/** In-section control-group heading (quieter than SettingsSection title). */
export const SettingsGroupTitle: React.FC<SettingsGroupTitleProps> = ({ children, className, as: Tag = 'h3' }) => (
  <Tag className={cn('sk-group-title m-0', className)}>{children}</Tag>
);

interface SettingsControlGroupProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  info?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

/** Labeled control cluster inside a section (radios, chips, stacked fields). */
export const SettingsControlGroup: React.FC<SettingsControlGroupProps> = ({ title, description, info, children, className, contentClassName, settingsItem }) => (
  <div data-settings-item={settingsItem} className={cn('sk-stack-field', className)}>
    {title != null || description != null ? <div>
      {title != null ? <div className="sk-sfl">{title}{info != null ? <Info>{info}</Info> : null}</div> : null}
      {description != null ? <div className="sk-sfd">{description}</div> : null}
    </div> : null}
    <div className={contentClassName}>{children}</div>
  </div>
);

interface SettingsStackedFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  info?: React.ReactNode;
  descriptionPlacement?: 'before' | 'after';
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
}

/** Label (+ optional description) above a control. */
export const SettingsStackedField: React.FC<SettingsStackedFieldProps> = ({ label, description, info, descriptionPlacement = 'before', children, settingsItem, className, controlClassName }) => (
  <div data-settings-item={settingsItem} className={cn('sk-stack-field', className)}>
    <div>
      <div className="sk-sfl">{label}{info != null ? <Info>{info}</Info> : null}</div>
      {description != null && descriptionPlacement === 'before' ? <div className="sk-sfd">{description}</div> : null}
    </div>
    <div className={cn('flex min-w-0 items-center gap-2', controlClassName)}>{children}</div>
    {description != null && descriptionPlacement === 'after' ? <div className="sk-sfd">{description}</div> : null}
  </div>
);

interface SettingsFieldRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  info?: React.ReactNode;
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
  alignEnd?: boolean;
  tag?: React.ReactNode;
  sub?: boolean;
  dim?: boolean;
}

/** Side-by-side row: label and explanation on the left, control on the right. */
export const SettingsFieldRow: React.FC<SettingsFieldRowProps> = ({ label, description, info, children, settingsItem, className, controlClassName, tag, sub, dim }) => (
  <div data-settings-item={settingsItem} className={cn('sk-row', sub && 'sub', dim && 'dim', className)}>
    <div className="sk-rl">
      <div className="sk-t">{label}{info != null ? <Info>{info}</Info> : null}{tag}</div>
      {description != null ? <div className="sk-d">{description}</div> : null}
    </div>
    <div className={cn('sk-rc', controlClassName)}>{children}</div>
  </div>
);

interface SettingsInsetProps {
  children: React.ReactNode;
  className?: string;
  settingsItem?: string;
}

/** Free content inside a section panel. */
export const SettingsInset: React.FC<SettingsInsetProps> = ({ children, className, settingsItem }) => (
  <div data-settings-item={settingsItem} className={cn('sk-pad', className)}>{children}</div>
);

interface SettingsCheckboxRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  settingsItem?: string;
  className?: string;
  labelAccessory?: React.ReactNode;
  info?: React.ReactNode;
  sub?: boolean;
}

/** A setting turned on or off with a switch. */
export const SettingsCheckboxRow: React.FC<SettingsCheckboxRowProps> = ({ checked, onChange, label, description, disabled = false, ariaLabel, settingsItem, className, labelAccessory, info, sub }) => {
  const labelId = React.useId();
  return <div data-settings-item={settingsItem} className={cn('sk-row', sub && 'sub', disabled && 'dim', className)}>
    <div className="sk-rl">
      <div className="sk-t" id={labelId}>{label}{labelAccessory}{info != null ? <Info>{info}</Info> : null}</div>
      {description != null ? <div className="sk-d">{description}</div> : null}
    </div>
    <div className="sk-rc"><Sw checked={checked} onChange={onChange} disabled={disabled} label={ariaLabel ?? (typeof label === 'string' ? label : '')} /></div>
  </div>;
};

interface SettingsRadioOptionProps {
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** Single radio option row used inside SettingsRadioGroup. */
export const SettingsRadioOption: React.FC<SettingsRadioOptionProps> = ({ selected, onSelect, label, description, ariaLabel, disabled = false, className }) => (
  <button type="button" role="radio" aria-checked={selected} aria-label={ariaLabel} disabled={disabled}
    className={cn('flex w-full cursor-pointer gap-3 py-1.5 text-left outline-none', description != null ? 'items-start' : 'items-center', disabled && 'cursor-not-allowed opacity-50', className)}
    onClick={() => { if (!selected) onSelect(); }}>
    <span aria-hidden className="mt-[3px] size-[15px] shrink-0 rounded-full transition-shadow" style={{ boxShadow: selected ? 'inset 0 0 0 4.5px var(--primary)' : 'inset 0 0 0 1.5px var(--sk-faint)' }} />
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[length:var(--sk-fs)] text-foreground">{label}</span>
      {description != null ? <span className="text-[length:var(--sk-fs-micro)] text-muted-foreground">{description}</span> : null}
    </span>
  </button>
);

interface SettingsRadioGroupProps {
  'aria-label': string;
  children: React.ReactNode;
  className?: string;
}

/** Accessible radio group wrapper with compact vertical spacing. */
export const SettingsRadioGroup: React.FC<SettingsRadioGroupProps> = ({ 'aria-label': ariaLabel, children, className }) => (
  <div role="radiogroup" aria-label={ariaLabel} className={cn('space-y-0.5', className)} onKeyDown={event => {
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role=radio]:not(:disabled)')];
    const index = options.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !options.length) return;
    event.preventDefault(); const next = options[(index + direction + options.length) % options.length]!; next.focus(); next.click();
  }}>{children}</div>
);

interface SettingsChipOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

interface SettingsChipGroupProps<T extends string> {
  value: T;
  options: Array<SettingsChipOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}

/** Enum picker rendered as a segmented control. */
export function SettingsChipGroup<T extends string>({ value, options, onChange, className, 'aria-label': ariaLabel }: SettingsChipGroupProps<T>) {
  return <Seg value={value} options={options} onChange={onChange} label={ariaLabel} className={className} />;
}
