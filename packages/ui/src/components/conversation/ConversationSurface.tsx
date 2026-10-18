import React from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

type PaintedScene = { owner: string; identity: string; content: React.ReactNode };

const ConversationScene: React.FC<{ children: React.ReactNode; inactive: boolean }> = ({ children, inactive }) => {
  const present = useIsPresent();
  const reduced = usePrefersReducedMotion();
  return <motion.div className="conversation-scene" inert={inactive || !present} aria-hidden={inactive || !present}
    initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -3 }}
    transition={{ duration: reduced ? 0 : .22, ease: [.22, 1, .36, 1] }}
    style={present ? undefined : { position: 'absolute', inset: 0 }}>
    {children}
  </motion.div>;
};

/** Keeps a painted conversation until the next history is available; drafts and execution stay elsewhere. */
export const ConversationSurface = React.forwardRef<HTMLDivElement, {
  owner: string; identity: string; ready: boolean; loadingLabel: string;
  children: React.ReactNode;
}>(({ owner, identity, ready, loadingLabel, children }, ref) => {
  const painted = React.useRef<PaintedScene | undefined>(undefined);
  if (painted.current?.owner !== owner) painted.current = undefined;
  if (ready) painted.current = { owner, identity, content: children };
  const scene = painted.current;
  // Virtual sticky rows use their own high z-indices. Keep them below sibling
  // conversation controls, including when an entrance animation drops its transform.
  return <div ref={ref} className="conversation-content isolate relative min-h-0 min-w-0 flex-1" aria-busy={!ready}
    data-conversation-hydrating={!ready || undefined}>
    <AnimatePresence key={owner} initial={false}>
      {scene ? <ConversationScene key={scene.identity} inactive={!ready || scene.identity !== identity}>
        {scene.content}
      </ConversationScene> : null}
    </AnimatePresence>
    {!ready ? <div role="status" className="conversation-loading typography-meta text-muted-foreground">
      <span className="truncate">{loadingLabel}</span>
    </div> : null}
  </div>;
});
