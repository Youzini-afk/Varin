import React from 'react';
import { Icon } from '@/components/icon/Icon';
import './context-manager.css';

export function ContextDisclosure({ title, hint, children, open: controlled, onOpenChange, defaultOpen = false, className = '' }: {
  title: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; open?: boolean; onOpenChange?(open: boolean): void; defaultOpen?: boolean; className?: string;
}) {
  const [local, setLocal] = React.useState(defaultOpen), open = controlled ?? local;
  const id = React.useId();
  return <section className={`context-disclosure ${className}`} data-open={open}>
    <button type="button" className="context-disclosure-heading" aria-expanded={open} aria-controls={id}
      onClick={() => { setLocal(!open); onOpenChange?.(!open); }}>
      <Icon name="arrow-right-s" className="context-chevron size-3" /><span>{title}</span>{hint && <small>{hint}</small>}
    </button>
    <div className="context-fold" id={id} inert={!open} aria-hidden={!open}><div>{children}</div></div>
  </section>;
}
