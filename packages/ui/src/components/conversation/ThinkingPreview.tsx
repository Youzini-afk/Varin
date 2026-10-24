import React from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SpringDriver, tokenSpring } from '@/lib/motion/spring';

const GLIDE = tokenSpring('glide');

/**
 * A one-line viewport following visual lines, rather than restarting an
 * animation for every token. A new line glides up on the glide spring and a
 * retarget keeps the current velocity, so a burst of lines does not stutter.
 */
export function ThinkingPreview({ text, streaming, active }: { text: string; streaming: boolean; active: boolean }) {
  const viewport = React.useRef<HTMLSpanElement>(null);
  const measured = React.useRef(false);
  const lastTarget = React.useRef(-1);
  const spring = React.useRef<SpringDriver | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const plain = React.useMemo(() => text.replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim(), [text]);
  React.useEffect(() => () => spring.current?.stop(), []);
  React.useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !active) { measured.current = false; spring.current?.stop(); return; }
    const glide = spring.current ??= new SpringDriver({
      spring: GLIDE,
      restDelta: 0.25,
      onUpdate: (value) => { if (viewport.current) viewport.current.scrollTop = value; },
    });
    const follow = () => {
      if (!node.clientHeight) return;
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      if (target === lastTarget.current && measured.current) return;
      const animate = measured.current && streaming && !reducedMotion;
      // A newly mounted/history block lands on the latest line immediately. A large incoming
      // batch animates only its last line, without replaying the accumulated reasoning.
      if (!animate) glide.jump(target);
      else {
        glide.sync(node.scrollTop);
        if (target - glide.value > node.clientHeight) glide.jump(target - node.clientHeight);
        glide.to(target);
      }
      measured.current = true;
      lastTarget.current = target;
    };
    follow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [plain, active, streaming, reducedMotion]);
  return <span ref={viewport} className="thinking-preview" aria-hidden="true">
    <span className="thinking-preview-text">{plain}</span>
  </span>;
}
