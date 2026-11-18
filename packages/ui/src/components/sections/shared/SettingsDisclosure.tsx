import React from 'react';
import { Disclosure } from './kit';
import './settings.css';

/** Native disclosure keeps editors mounted and remains discoverable by settings search. */
export function SettingsDisclosure({ title, summary, children, defaultOpen = false, settingsItem }: {
  title: React.ReactNode;
  summary?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  settingsItem?: string;
  className?: string;
}) {
  return <Disclosure label={title} summary={summary} defaultOpen={defaultOpen} item={settingsItem}>
    <div className="sk-free">{children}</div>
  </Disclosure>;
}
