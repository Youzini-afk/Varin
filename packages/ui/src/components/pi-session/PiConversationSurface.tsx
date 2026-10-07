import React from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Icon } from '@/components/icon/Icon';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { HarnessThreadStateContext, useHarnessThreadState, type HarnessThreadStateValue } from './HarnessThreadStateContext';

type PaintedScene = { owner: string; identity: string; content: React.ReactNode; threadState: HarnessThreadStateValue };

const ConversationScene: React.FC<{ children: React.ReactNode; inactive: boolean }> = ({ children, inactive }) => {
  const present = useIsPresent();
  const reduced = usePrefersReducedMotion();
  return <motion.div className="pi-conversation-scene" inert={inactive || !present} aria-hidden={inactive || !present}
    initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -3 }}
    transition={{ duration: reduced ? 0 : .22, ease: [.22, 1, .36, 1] }}
    style={present ? undefined : { position: 'absolute', inset: 0 }}>
    {children}
  </motion.div>;
};

/** Keeps a painted conversation until the next history is available; drafts and execution stay elsewhere. */
export const PiConversationSurface = React.forwardRef<HTMLDivElement, {
  owner: string; identity: string; ready: boolean; loadingLabel: string;
  children: React.ReactNode;
}>(({ owner, identity, ready, loadingLabel, children }, ref) => {
  const threadState = useHarnessThreadState();
  const painted = React.useRef<PaintedScene | undefined>(undefined);
  if (painted.current?.owner !== owner) painted.current = undefined;
  if (ready) painted.current = { owner, identity, content: children, threadState };
  const scene = painted.current;
  return <div ref={ref} className="pi-conversation-content relative min-h-0 min-w-0" aria-busy={!ready}
    data-pi-conversation-hydrating={!ready || undefined}>
    <AnimatePresence key={owner} initial={false}>
      {scene ? <ConversationScene key={scene.identity} inactive={!ready || scene.identity !== identity}>
        <HarnessThreadStateContext.Provider value={scene.threadState}>{scene.content}</HarnessThreadStateContext.Provider>
      </ConversationScene> : null}
    </AnimatePresence>
    {!ready ? <div role="status" className="pi-conversation-loading flex items-center gap-2 typography-meta text-muted-foreground">
      <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" /><span className="truncate">{loadingLabel}</span>
    </div> : null}
  </div>;
});
