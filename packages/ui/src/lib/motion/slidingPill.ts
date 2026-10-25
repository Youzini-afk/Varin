import { documentMotionLevel } from './preference';
import { SpringDriver, tokenSpring } from './spring';

/**
 * Shared pieces of the "one highlight for the whole list" pattern (docs/design/motion-and-interaction.md
 * §2): the rail's bar, the settings selection, menu and sidebar highlights and tab underlines each draw
 * a single element that moves between items instead of every item painting its own.
 */

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * `element`'s box in `root`'s scrolled content coordinates, which is where an absolutely positioned
 * child of `root` (inside its border) lands.
 */
export function boxWithin(element: Element, root: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  const frame = root.getBoundingClientRect();
  return {
    top: rect.top - frame.top - root.clientTop + root.scrollTop,
    left: rect.left - frame.left - root.clientLeft + root.scrollLeft,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Apply `change` while the element carries `data-placing`, flushing styles before it is removed, so
 * whatever its stylesheet makes instant under `data-placing` jumps instead of sliding: a highlight's
 * first appearance lands in place rather than travelling in from the corner.
 */
export function placeInstantly(element: HTMLElement, change: () => void): void {
  element.setAttribute('data-placing', '');
  change();
  void element.offsetWidth;
  element.removeAttribute('data-placing');
}

export interface SlidingPill {
  readonly element: HTMLElement;
  readonly visible: boolean;
  /**
   * Move to `y` along the list (and take the given box at once). It slides on glide when it was
   * already showing at full motion and `animate` is set, or when it is still sliding; otherwise it
   * jumps. Retargeting mid-slide carries the velocity.
   */
  moveTo(target: { y: number; left?: number; width?: number; height?: number }, animate: boolean): void;
  hide(): void;
  dispose(): void;
}

/** A spring-driven indicator prepended to `root`, hidden until first placed. */
export function createSlidingPill(root: HTMLElement, className: string): SlidingPill {
  const element = root.ownerDocument.createElement('span');
  element.className = className;
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('data-hidden', '');
  root.prepend(element);
  const driver = new SpringDriver({ spring: tokenSpring('glide'), onUpdate: (value) => { element.style.translate = `0 ${value}px`; } });
  let visible = false;
  return {
    element,
    get visible() { return visible; },
    moveTo: ({ y, left, width, height }, animate) => {
      if (left !== undefined) element.style.left = `${left}px`;
      if (width !== undefined) element.style.width = `${width}px`;
      if (height !== undefined) element.style.height = `${height}px`;
      if (visible && documentMotionLevel() === 'full' && (animate || driver.active)) driver.to(y);
      else driver.jump(y);
      element.removeAttribute('data-hidden');
      visible = true;
    },
    hide: () => {
      element.setAttribute('data-hidden', '');
      visible = false;
    },
    dispose: () => {
      driver.stop();
      element.remove();
      visible = false;
    },
  };
}
