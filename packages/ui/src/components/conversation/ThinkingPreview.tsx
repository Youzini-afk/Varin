import React from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/** A one-line viewport following visual lines, rather than restarting an animation for every token. */
export function ThinkingPreview({ text, streaming, active }: { text: string; streaming: boolean; active: boolean }) {
  const viewport = React.useRef<HTMLSpanElement>(null);
  const measured = React.useRef(false);
  const lastTarget = React.useRef(-1);
  const reducedMotion = usePrefersReducedMotion();
  const plain = React.useMemo(() => text.replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim(), [text]);
  React.useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !active) { measured.current = false; return; }
    const follow = () => {
      if (!node.clientHeight) return;
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      if (target === lastTarget.current && measured.current) return;
      const animate = measured.current && streaming && !reducedMotion;
      // A newly mounted/history block lands on the latest line immediately. A large incoming
      // batch animates only its last line, without replaying the accumulated reasoning.
      if (!animate) node.scrollTop = target;
      else {
        if (target - node.scrollTop > node.clientHeight) node.scrollTop = target - node.clientHeight;
        node.scrollTo({ top: target, behavior: 'smooth' });
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
