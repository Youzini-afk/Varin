import React from 'react';
import { createPortal } from 'react-dom';
import { SettingsFooterContext } from './settings-context';
import { SaveDock, UnitBar } from './kit';
import './settings.css';

export interface SettingsActionBarProps {
  dirty: boolean;
  saving?: boolean;
  onSave?: () => unknown | Promise<unknown>;
  onCancel: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  error?: string | null;
  children?: React.ReactNode;
  className?: string;
  placement?: 'page' | 'inline';
  message?: React.ReactNode;
}

/** One save unit with the owner's real draft and status: a floating dock over the page, or an inline bar inside a panel. */
export function SettingsActionBar({ dirty, saving = false, onSave, onCancel, saveDisabled = false, saveLabel, error, children, placement = 'page', message }: SettingsActionBarProps) {
  const target = React.useContext(SettingsFooterContext);
  const props = { dirty, saving, onSave, onCancel, saveDisabled, saveLabel, error: error || undefined, extra: children, message };
  if (placement === 'inline') return <UnitBar {...props} standalone />;
  const dock = <SaveDock {...props} />;
  return target ? createPortal(dock, target) : dock;
}
