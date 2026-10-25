import React from 'react';
import { AnimatePresence, motion, useIsPresent, type Variants } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { requestFrame } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import { recentSwitchDirection, type SwitchDirection } from '@/lib/motion/switchDirection';
import { EASE_EXIT, springTiming, staggerDelay, TWEENS } from '@/lib/motion/tokens';

type PaintedScene = { owner: string; identity: string; content: React.ReactNode };

const SHIFT_PX = 8;
/** How long a new conversation may take to draw its first turns before the stagger gives up. */
const STAGGER_WAIT_MS = 400;

/**
 * The turns a switched-to conversation shows first arrive one after another,
 * top to bottom, from the side the user moved toward.
 */
function staggerTurns(scene: HTMLElement, direction: SwitchDirection): void {
  const level = documentMotionLevel();
  if (level === 'off' || typeof scene.animate !== 'function') return;
  const shift = level === 'full' ? (direction || 1) * SHIFT_PX : 0;
  const started = performance.now();
  const run = () => {
    if (!scene.isConnected) return;
    const box = scene.getBoundingClientRect();
    const blocks = [...scene.querySelectorAll<HTMLElement>('[data-turn-id]')]
      .map(block => ({ block, rect: block.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom)
      .sort((left, right) => left.rect.top - right.rect.top);
    if (!blocks.length) {
      if (performance.now() - started < STAGGER_WAIT_MS) requestFrame(run);
      return;
    }
    const turns = [...new Set(blocks.map(({ block }) => block.dataset.turnId))];
    for (const { block } of blocks) {
      block.animate(
        [{ opacity: 0, transform: shift ? `translateY(${shift}px)` : 'none' }, { opacity: 1, transform: 'none' }],
        { ...springTiming('glide'), delay: staggerDelay(turns.indexOf(block.dataset.turnId)) * 1000, fill: 'backwards' },
      );
    }
  };
  requestFrame(run);
}

const ConversationScene: React.FC<{ children: React.ReactNode; inactive: boolean; entering: SwitchDirection | null }> = ({ children, inactive, entering }) => {
  const present = useIsPresent();
  const reduced = usePrefersReducedMotion();
  const node = React.useRef<HTMLDivElement>(null);
  const staggered = React.useRef(false);
  React.useEffect(() => {
    if (entering === null || inactive || staggered.current || !node.current) return;
    staggered.current = true;
    staggerTurns(node.current, entering);
  }, [entering, inactive]);
  // The leaving conversation goes against the move through the session list, quickly.
  const variants = React.useMemo<Variants>(() => ({
    enter: { opacity: reduced ? 1 : 0 },
    shown: { opacity: 1, transition: { duration: reduced ? 0 : TWEENS.fade.duration, ease: [.22, 1, .36, 1] } },
    leave: (direction: SwitchDirection) => ({
      opacity: 0, y: reduced ? 0 : direction === 0 ? -3 : -direction * SHIFT_PX,
      transition: { duration: reduced ? 0 : TWEENS.exit.duration, ease: [...EASE_EXIT] },
    }),
  }), [reduced]);
  return <motion.div ref={node} className="conversation-scene" inert={inactive || !present} aria-hidden={inactive || !present}
    variants={variants} initial="enter" animate="shown" exit="leave"
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
  const previous = painted.current?.identity;
  if (ready) painted.current = { owner, identity, content: children };
  const scene = painted.current;
  // Which way the current scene arrived, decided once when it replaces another
  // (null for the first scene, which is not animated in).
  const arrival = React.useRef<{ identity: string; direction: SwitchDirection | null } | null>(null);
  if (scene && arrival.current?.identity !== scene.identity) {
    arrival.current = { identity: scene.identity, direction: previous !== undefined && previous !== scene.identity ? recentSwitchDirection() : null };
  }
  const entering = arrival.current?.direction ?? null;
  const direction = entering ?? 0;
  // Virtual sticky rows use their own high z-indices. Keep them below sibling
  // conversation controls, including when an entrance animation drops its transform.
  return <div ref={ref} className="conversation-content isolate relative min-h-0 min-w-0 flex-1" aria-busy={!ready}
    data-conversation-hydrating={!ready || undefined}>
    <AnimatePresence key={owner} initial={false} custom={direction}>
      {scene ? <ConversationScene key={scene.identity} inactive={!ready || scene.identity !== identity} entering={entering}>
        {scene.content}
      </ConversationScene> : null}
    </AnimatePresence>
    {!ready ? <div role="status" className="conversation-loading typography-meta text-muted-foreground">
      <span className="truncate">{loadingLabel}</span>
    </div> : null}
  </div>;
});
