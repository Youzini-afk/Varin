import React from 'react';
import { boxWithin, placeInstantly } from '@/lib/motion/slidingPill';

/**
 * The highlight of a Base UI menu, drawn once and moved between items on the
 * snap spring instead of jumping from row to row with the pointer or the
 * arrow keys. The menu is marked `data-menu-highlight` so its items stop
 * painting their own. A checked item keeps its selection colour and hides the
 * highlight. Render it as the popup's first child.
 */
export function MenuHighlight() {
  const pill = React.useRef<HTMLSpanElement>(null);

  React.useLayoutEffect(() => {
    const node = pill.current;
    const menu = node?.parentElement;
    if (!node || !menu || typeof MutationObserver === 'undefined') return undefined;
    menu.setAttribute('data-menu-highlight', '');
    let visible = false;
    const place = () => {
      const item = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"][data-highlighted]')]
        .find(candidate => candidate.closest('[data-menu-highlight]') === menu);
      if (!item || item.hasAttribute('data-checked')) {
        node.setAttribute('data-hidden', '');
        visible = false;
        return;
      }
      const box = boxWithin(item, menu);
      const apply = () => {
        node.style.setProperty('--highlight-x', `${box.left}px`);
        node.style.setProperty('--highlight-y', `${box.top}px`);
        node.style.setProperty('--highlight-width', `${box.width}px`);
        node.style.setProperty('--highlight-height', `${box.height}px`);
        node.toggleAttribute('data-destructive', item.dataset.variant === 'destructive');
        node.removeAttribute('data-hidden');
      };
      // The first highlight appears in place; later ones slide from the last.
      if (visible) apply();
      else placeInstantly(node, apply);
      visible = true;
    };
    const observer = new MutationObserver(place);
    observer.observe(menu, { subtree: true, attributes: true, attributeFilter: ['data-highlighted'] });
    place();
    return () => {
      observer.disconnect();
      menu.removeAttribute('data-menu-highlight');
    };
  }, []);

  return <span ref={pill} aria-hidden="true" className="menu-highlight" data-hidden="" />;
}
