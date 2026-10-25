import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { EASE_EXIT, EASE_OUT, springTiming, staggerDelay, TWEENS } from '@/lib/motion/tokens';

/*
 * Sidebar motion. The list is plain React rows; motion is layered on the DOM
 * so rows keep their structure and their tests:
 *
 * - `FlipList` is the scroller. Items carry `data-flip-key`; it measures them
 *   before every commit and animates what changed.
 * - `useSelectionGlide` (sidebarHighlights.ts) carries the selection from row to row.
 * - `useHoverPill` draws one hover highlight that follows the pointer.
 */

const KEY = 'data-flip-key';
/** More arrivals than this at once is a reload, not a change worth animating. */
const MAX_ENTERING = 12;
const MAX_MOVING = 80;
/** How long rows wait before closing a removed row's gap. */
const CLOSE_DELAY_MS = 70;
const cubic = (points: readonly number[]) => `cubic-bezier(${points.join(', ')})`;

interface Measured {
  element: HTMLElement;
  rect: DOMRect;
  /** Keys of the keyed ancestors, nearest first. */
  ancestors: string[];
}
type Snapshot = { items: Map<string, Measured>; collapsed: Set<string> };

const keyOf = (element: Element): string => element.getAttribute(KEY) ?? '';
const ancestorsOf = (element: HTMLElement, root: HTMLElement): string[] => {
  const keys: string[] = [];
  for (let node = element.parentElement?.closest<HTMLElement>(`[${KEY}]`); node && root.contains(node); node = node.parentElement?.closest<HTMLElement>(`[${KEY}]`)) {
    keys.push(keyOf(node));
  }
  return keys;
};

interface FlipListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** A change means the content was replaced (a search), not moved: that commit is not animated. */
  instantKey?: string;
  /** Ordered visible identities and expansion/editing state. Status/text
   * updates with unchanged geometry leave running motions and measurements alone. */
  layoutKey?: string;
  containerRef?: React.Ref<HTMLDivElement>;
}

/**
 * A scroller whose keyed items move instead of jumping:
 *
 * - Items that move (a pin, new activity, a group collapsing above) slide on
 *   glide from where they were drawn, including mid-slide.
 * - A session that has never been seen settles in; rows of a group that
 *   expands enter 20ms apart; the first population fades in.
 * - A removed item leaves to the left as a paint-only copy of its own node
 *   while the rest close the gap; rows of a group that collapses just fade.
 *
 * Mark collapsible containers `data-collapsed` while collapsed.
 */
export class FlipList extends React.Component<FlipListProps> {
  private node: HTMLDivElement | null = null;
  /** Every key seen since mount: an unknown one is new, a known one is returning. */
  private known = new Set<string>();
  private lastInstantKey = this.props.instantKey;
  private moving = new Map<HTMLElement, Set<Animation>>();
  private ghosts = new Set<HTMLElement>();

  private setNode = (node: HTMLDivElement | null): void => {
    this.node = node;
    const { containerRef } = this.props;
    if (typeof containerRef === 'function') containerRef(node);
    else if (containerRef) (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  };

  componentDidMount(): void {
    if (this.node) this.remember(this.measure(this.node));
  }

  componentWillUnmount(): void {
    for (const element of [...this.moving.keys()]) this.stopMoving(element);
    for (const ghost of this.ghosts) ghost.remove();
    this.ghosts.clear();
  }

  getSnapshotBeforeUpdate(previous: FlipListProps): Snapshot | null {
    if (this.props.layoutKey !== undefined && previous.layoutKey === this.props.layoutKey && previous.instantKey === this.props.instantKey) return null;
    return this.node ? this.measure(this.node) : null;
  }

  componentDidUpdate(_previous: FlipListProps, _state: unknown, before: Snapshot | null): void {
    const root = this.node;
    const instant = this.props.instantKey !== this.lastInstantKey;
    this.lastInstantKey = this.props.instantKey;
    if (!root || !before) return;
    const level = documentMotionLevel();
    if (instant || level === 'off' || typeof root.animate !== 'function') {
      for (const element of [...this.moving.keys()]) this.stopMoving(element);
      this.remember(this.measure(root));
      return;
    }
    // Keep existing translations while measuring the layout delta. Before and
    // after contain the same animation offset, so it cancels out; a retarget
    // adds the delta to the live spring without dropping its velocity.
    const after = this.measure(root);
    // The first rows to appear (a catalog loading) fade in; later new ones settle.
    const firstPopulation = ![...before.items.values()].some(item => item.element.hasAttribute('data-flip-arrive'));
    const reduced = level === 'reduced';

    // Moves: each item slides by its own offset less what its keyed ancestor already slides.
    const offsets = new Map<string, { x: number; y: number }>();
    const moves: Array<{ element: HTMLElement; x: number; y: number }> = [];
    for (const [key, now] of after.items) {
      const then = before.items.get(key);
      if (!then) continue;
      const own = { x: then.rect.left - now.rect.left, y: then.rect.top - now.rect.top };
      offsets.set(key, own);
      const parent = now.ancestors[0] ? offsets.get(now.ancestors[0]) : undefined;
      const x = own.x - (parent?.x ?? 0);
      const y = own.y - (parent?.y ?? 0);
      if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) moves.push({ element: now.element, x, y });
    }
    // Departures, found before moving so the rest can wait for them.
    const removed = [...before.items].filter(([key, then]) => !after.items.has(key) && !then.element.isConnected);
    const removedKeys = new Set(removed.map(([key]) => key));
    const leaving = removed.filter(([, then]) => !then.ancestors.some(ancestor => removedKeys.has(ancestor)));
    const deleting = leaving.some(([, then]) => !then.ancestors.some(ancestor => after.collapsed.has(ancestor)));
    if (!reduced && moves.length <= MAX_MOVING) {
      // Rows close a removed row's gap a beat later, once its copy has mostly faded.
      for (const { element, x, y } of moves) {
        this.move(element, x, y, deleting);
      }
    }

    // Arrivals: the outermost new item animates for its subtree.
    const entering = [...after.items].filter(([key, now]) => !before.items.has(key) && !now.ancestors.some(ancestor => !before.items.has(ancestor) && after.items.has(ancestor)));
    const staggered = new Map<string, number>();
    const fading = entering.length > MAX_ENTERING ? null : entering;
    for (const [key, now] of entering) {
      const opened = now.ancestors.find(ancestor => before.collapsed.has(ancestor) && !after.collapsed.has(ancestor));
      if (opened !== undefined) {
        const index = staggered.get(opened) ?? 0;
        staggered.set(opened, index + 1);
        now.element.animate(
          [{ opacity: 0, transform: reduced ? 'none' : 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
          { ...springTiming('glide'), delay: staggerDelay(index) * 1000, fill: 'backwards' },
        );
      } else if (!fading) {
        continue;
      } else if (!firstPopulation && !this.known.has(key) && now.element.hasAttribute('data-flip-arrive')) {
        now.element.style.transformOrigin = 'left center';
        now.element.animate(
          [{ opacity: 0, transform: reduced ? 'none' : 'translateX(-6px) scale(.97)' }, { opacity: 1, transform: 'none' }],
          springTiming('settle'),
        );
      } else {
        const index = staggered.get('') ?? 0;
        staggered.set('', index + 1);
        now.element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: TWEENS.fade.duration * 1000, easing: cubic(EASE_OUT), delay: firstPopulation ? staggerDelay(index) * 1000 : 0, fill: 'backwards',
        });
      }
    }

    // Departures: the outermost removed item leaves as its own detached node.
    const box = root.getBoundingClientRect();
    for (const [, then] of leaving) {
      const folded = then.ancestors.some(ancestor => after.collapsed.has(ancestor));
      this.depart(root, box, then, folded, reduced);
    }
    this.remember(after);
  }

  private depart(root: HTMLElement, box: DOMRect, item: Measured, folded: boolean, reduced: boolean): void {
    const ghost = item.element;
    this.stopMoving(ghost);
    for (const element of [ghost, ...ghost.querySelectorAll(`[${KEY}]`)]) element.removeAttribute(KEY);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('data-flip-ghost', '');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'absolute', margin: '0', pointerEvents: 'none', transformOrigin: 'left center',
      left: `${item.rect.left - box.left - root.clientLeft + root.scrollLeft}px`,
      top: `${item.rect.top - box.top - root.clientTop + root.scrollTop}px`,
      width: `${item.rect.width}px`, height: `${item.rect.height}px`,
    });
    root.prepend(ghost);
    this.ghosts.add(ghost);
    const away = reduced ? 'none' : folded ? 'translateY(-4px)' : 'translateX(-14px)';
    // A removed row fades early (out-curve) and drifts left; a folded one just goes.
    const leave = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: away }], folded
      ? { duration: TWEENS.exit.duration * 1000, easing: cubic(EASE_EXIT), fill: 'forwards' }
      : { duration: TWEENS.fade.duration * 1000, easing: cubic(EASE_OUT), fill: 'forwards' });
    const done = () => { ghost.remove(); this.ghosts.delete(ghost); };
    void leave.finished.then(done, done);
  }

  private move(element: HTMLElement, x: number, y: number, deleting: boolean): void {
    const motions = this.moving.get(element) ?? new Set<Animation>();
    // The additional displacement starts at rest; the previous animation
    // keeps its velocity. Both finish at zero on the original glide curve,
    // entirely in the compositor, without a JS loop for each sidebar row.
    const animation = element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], {
      ...springTiming('glide'), composite: 'add', fill: 'backwards', delay: deleting && !motions.size ? CLOSE_DELAY_MS : 0,
    });
    motions.add(animation);
    this.moving.set(element, motions);
    const release = () => {
      motions.delete(animation);
      if (!motions.size && this.moving.get(element) === motions) this.moving.delete(element);
    };
    void animation.finished.then(release, release);
  }

  private stopMoving(element: HTMLElement): void {
    for (const animation of this.moving.get(element) ?? []) animation.cancel();
    this.moving.delete(element);
  }

  private measure(root: HTMLElement): Snapshot {
    const items = new Map<string, Measured>();
    const collapsed = new Set<string>();
    for (const element of root.querySelectorAll<HTMLElement>(`[${KEY}]`)) {
      const key = keyOf(element);
      if (element.hasAttribute('data-collapsed')) collapsed.add(key);
      const rect = element.getBoundingClientRect();
      // Hidden content (a collapsed section kept mounted) has no place to move from.
      if (!rect.width && !rect.height) continue;
      items.set(key, { element, rect, ancestors: ancestorsOf(element, root) });
    }
    return { items, collapsed };
  }

  private remember(snapshot: Snapshot): void {
    for (const key of snapshot.items.keys()) this.known.add(key);
  }

  render(): React.ReactNode {
    const { instantKey: _instantKey, layoutKey: _layoutKey, containerRef: _containerRef, children, ...rest } = this.props;
    void _instantKey; void _containerRef;
    void _layoutKey;
    return <div ref={this.setNode} {...rest}>{children}</div>;
  }
}

