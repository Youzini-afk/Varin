import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { EASE_EXIT, staggerDelay, TWEENS } from '@/lib/motion/tokens';

type Exit = 'rise' | 'sink';

interface DepartureProps {
  /** While true the content renders; when it turns false the content leaves. */
  present: boolean;
  /** `rise` leaves upward, `sink` downward. */
  exit: Exit;
  /** Parts that leave one after another, such as starter chips. */
  stagger?: string;
  /** False removes the content at once, for departures that are not the user's doing. */
  animated?: boolean;
  className?: string;
  children?: React.ReactNode;
}

interface Departing {
  copy: HTMLElement;
  host: HTMLElement;
}

const SHIFT_PX: Record<Exit, number> = { rise: -10, sink: 6 };
const exitTiming = { duration: TWEENS.exit.duration * 1000, easing: `cubic-bezier(${EASE_EXIT.join(', ')})`, fill: 'forwards' as const };

/** A paint-only copy of `node`, placed where it is now inside its offset parent. */
function detach(node: HTMLElement): Departing | null {
  if (typeof node.animate !== 'function' || documentMotionLevel() === 'off') return null;
  const host = node.offsetParent;
  if (!(host instanceof HTMLElement)) return null;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const frame = host.getBoundingClientRect();
  const copy = node.cloneNode(true) as HTMLElement;
  // The copy is paint only: no heading, focus target or duplicate id.
  for (const heading of copy.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const plain = document.createElement('div');
    for (const { name, value } of [...heading.attributes]) plain.setAttribute(name, value);
    plain.append(...heading.childNodes);
    heading.replaceWith(plain);
  }
  for (const element of copy.querySelectorAll('[id]')) {
    if (!(element instanceof SVGElement)) element.removeAttribute('id');
  }
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('data-departing', '');
  copy.inert = true;
  Object.assign(copy.style, {
    position: 'absolute', margin: '0', pointerEvents: 'none',
    left: `${rect.left - frame.left - (host.clientLeft || 0) + (host.scrollLeft || 0)}px`,
    top: `${rect.top - frame.top - (host.clientTop || 0) + (host.scrollTop || 0)}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
  });
  return { copy, host };
}

/**
 * Content that leaves through a detached copy. React removes the real content
 * in the same commit, so the layout moves on at once (the composer starts
 * docking) and nothing semantic lingers, while the copy fades out where the
 * content was: the title rises, starters sink one after another.
 *
 * The copy goes first in its offset parent, so moving positioned content,
 * such as the docking composer, passes over it. Reduced motion fades without
 * movement; off removes at once.
 */
export class Departure extends React.Component<DepartureProps> {
  private node: HTMLDivElement | null = null;
  private departing: Departing | null = null;

  private setNode = (node: HTMLDivElement | null): void => { this.node = node; };

  getSnapshotBeforeUpdate(previous: DepartureProps): Departing | null {
    if (!previous.present || this.props.present || this.props.animated === false || !this.node) return null;
    return detach(this.node);
  }

  componentDidUpdate(_previous: DepartureProps, _state: unknown, departing: Departing | null): void {
    if (this.props.present) { this.clear(); return; }
    if (!departing) return;
    this.clear();
    this.departing = departing;
    const { copy, host } = departing;
    host.prepend(copy);
    const shift = documentMotionLevel() === 'full' ? SHIFT_PX[this.props.exit] : 0;
    const keyframes = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: shift ? `translateY(${shift}px)` : 'none' }];
    const parts = this.props.stagger ? [...copy.querySelectorAll<HTMLElement>(this.props.stagger)] : [];
    const animations = parts.length
      ? parts.map((part, index) => part.animate(keyframes, { ...exitTiming, delay: staggerDelay(index) * 1000 }))
      : [copy.animate(keyframes, exitTiming)];
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (this.departing === departing) this.clear();
    });
  }

  componentWillUnmount(): void { this.clear(); }

  private clear(): void {
    this.departing?.copy.remove();
    this.departing = null;
  }

  render(): React.ReactNode {
    const { present, className, children } = this.props;
    return present ? <div ref={this.setNode} className={className}>{children}</div> : null;
  }
}
