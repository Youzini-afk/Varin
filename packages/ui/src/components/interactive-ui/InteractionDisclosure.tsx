import React from 'react';
import { Icon } from '@/components/icon/Icon';
import './interaction.css';

/** Keep the content mounted while CSS reverses from the current expansion. */
export function InteractionDisclosure({ title, children, open: controlled, onOpenChange }: {
  title: React.ReactNode; children: React.ReactNode; open?: boolean; onOpenChange?(open: boolean): void;
}) {
  const [local, setLocal] = React.useState(false);
  const open = controlled ?? local, id = React.useId();
  const trigger = React.useRef<HTMLButtonElement>(null), body = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => { if (!open && body.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true }); }, [open]);
  return <div className="conversation-ui-disclosure" data-open={open}>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={id} onClick={() => { setLocal(!open); onOpenChange?.(!open); }}>
      <Icon name="arrow-right-s" className="size-4 shrink-0" /><span>{title}</span>
    </button>
    <div id={id} ref={body} className="conversation-ui-reveal" data-open={open} aria-hidden={!open} inert={!open}>
      <div><div className="pt-2">{children}</div></div>
    </div>
  </div>;
}
