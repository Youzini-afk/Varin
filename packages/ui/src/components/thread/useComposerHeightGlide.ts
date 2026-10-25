import React from 'react';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import { SpringDriver, tokenSpring } from '@/lib/motion/spring';

/**
 * Composer height. Typing changes it at once, so text never waits for its
 * box. Everything else glides: a send or clear, the delivery row arriving as
 * a run starts and leaving when it ends, attachments. The timeline above is
 * uncovered or covered smoothly instead of jumping.
 *
 * The frame's height is what moves and its content is what is measured, so
 * the observers never see their own writes. A clear moves the hint row with
 * the frame (`data-height-glide` turns its own transition off) so the glide
 * knows its destination at once. While a glide runs it follows every later
 * change on the same spring.
 */
export function useComposerHeightGlide(
  frameRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
  empty: boolean,
): void {
  const control = React.useRef<{ setEmpty(value: boolean): void } | null>(null);

  React.useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const style = getComputedStyle(frame);
    const edges = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
    const natural = () => content.getBoundingClientRect().height + edges;
    // The editor shows its placeholder only for an empty document; a select-all
    // and delete reaches the DOM before React re-renders with the empty value.
    const placeholder = () => content.querySelector('.cm-placeholder') !== null;
    let draftEmpty = empty;
    let editorEmpty = draftEmpty || placeholder();
    // The height on screen when no glide holds the frame.
    let resting = natural();
    let pending: FrameHandle | null = null;
    const release = () => {
      frame.style.height = '';
      frame.style.justifyContent = '';
      delete frame.dataset.heightGlide;
      resting = natural();
    };
    const driver = new SpringDriver({
      spring: tokenSpring('glide'),
      restDelta: 0.5,
      restSpeed: 12,
      onUpdate: value => { frame.style.height = `${value}px`; },
      onRest: release,
    });
    /** `records` are the DOM changes behind this check; none for a draft or resize change. */
    const check = (records?: readonly MutationRecord[]) => {
      pending?.cancel();
      pending = null;
      const nowEmpty = draftEmpty || placeholder();
      const cleared = nowEmpty && !editorEmpty;
      editorEmpty = nowEmpty;
      const editor = content.querySelector('.cm-editor');
      if (!nowEmpty && records?.some(record => editor?.contains(record.target))) {
        // Typing: the box follows the text at once, even mid-glide.
        if (driver.active) { driver.stop(); release(); } else resting = natural();
        return;
      }
      if (cleared && documentMotionLevel() === 'full') frame.dataset.heightGlide = '';
      const target = natural();
      if (driver.active) { driver.to(target); return; }
      if (Math.abs(target - resting) <= 1 || (!records && !cleared) || documentMotionLevel() !== 'full') {
        delete frame.dataset.heightGlide;
        return;
      }
      // Content sits at the bottom while the top edge moves to it.
      frame.style.justifyContent = 'flex-end';
      driver.jump(resting);
      driver.to(target);
    };
    // Size changes without DOM changes: the hint row on focus, wrapping after a resize.
    const resize = new ResizeObserver(() => {
      if (!driver.active) { resting = natural(); return; }
      // Layout is never written inside the observer; the glide follows next frame.
      pending ??= requestFrame(() => check());
    });
    // Editor text, the footer and attachments change in the DOM before the next paint.
    const mutations = new MutationObserver(records => check(records));
    resize.observe(content);
    mutations.observe(content, { childList: true, characterData: true, subtree: true });
    control.current = { setEmpty(value) { if (value === draftEmpty) return; draftEmpty = value; check(); } };
    return () => {
      control.current = null;
      resize.disconnect();
      mutations.disconnect();
      pending?.cancel();
      driver.stop();
      release();
    };
    // `empty` is read once here; later values arrive through `setEmpty`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRef, contentRef]);

  React.useLayoutEffect(() => { control.current?.setEmpty(empty); }, [empty]);
}
