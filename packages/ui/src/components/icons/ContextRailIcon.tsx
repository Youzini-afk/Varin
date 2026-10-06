import type { ComponentPropsWithoutRef } from 'react';

/** The resource rail's boundary and three slots, shared with the approved workbench design. */
export function ContextRailIcon(props: ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" {...props}>
      <path d="M5 4v16" />
      <path fill="currentColor" stroke="none" d="M12.8 4h3.4q.8 0 .8.8v2.4q0 .8-.8.8h-3.4q-.8 0-.8-.8V4.8q0-.8.8-.8Zm0 6h3.4q.8 0 .8.8v2.4q0 .8-.8.8h-3.4q-.8 0-.8-.8v-2.4q0-.8.8-.8Zm0 6h3.4q.8 0 .8.8v2.4q0 .8-.8.8h-3.4q-.8 0-.8-.8v-2.4q0-.8.8-.8Z" />
    </svg>
  );
}
