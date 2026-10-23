import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import './settings.css';

/** Native disclosure keeps editors mounted and remains discoverable by settings search. */
export function SettingsDisclosure({ title, summary, children, defaultOpen = false, settingsItem, className }: {
  title: React.ReactNode;
  summary?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  settingsItem?: string;
  className?: string;
}) {
  return <details open={defaultOpen || undefined} data-settings-item={settingsItem} className={cn('settings-disclosure', className)}>
    <summary><Icon name="arrow-right-s" className="settings-disclosure-chevron size-4 shrink-0" />
      <span className="min-w-0 flex-1">{title}</span>{summary ? <span className="settings-disclosure-summary">{summary}</span> : null}
    </summary>
    <div className="settings-disclosure-body">{children}</div>
  </details>;
}
