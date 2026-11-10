import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { composerReferences, composerMarkerObjectId, isComposerMarker, type ComposerReference } from './references';
import { composerMarkerObjects, moveComposerMarker, snapMarkerPosition } from './markers';

interface DragOptions { onOpen(reference: ComposerReference): void; isComposing?(): boolean }
interface Press { input: 'pointer' | 'touch'; reference: ComposerReference; element: HTMLElement; pointer: number; x: number; y: number; startX: number; startY: number; offsetX: number; offsetY: number; active: boolean; target: number | null }
export const MARKER_HOLD_MS = 350;
/** Transient DOM-only gesture state. Only a completed, nonempty move creates a transaction. */
export function composerMarkerDrag(options: DragOptions) {
  return ViewPlugin.fromClass(class {
    press: Press | null = null;
    timer: ReturnType<typeof setTimeout> | undefined;
    frame = 0;
    previousFrame = 0;
    floating: HTMLElement | null = null;
    caret: HTMLElement | null = null;
    settling: HTMLElement | null = null;
    settleTimer: ReturnType<typeof setTimeout> | undefined;
    suppressClick = false;
    destroyed = false;
    constructor(readonly view: EditorView) {
      const doc = view.dom.ownerDocument;
      doc.addEventListener('pointermove', this.move, { passive: false });
      doc.addEventListener('pointerup', this.up);
      doc.addEventListener('pointercancel', this.pointerCancel);
      doc.addEventListener('touchmove', this.touchMove, { passive: false });
      doc.addEventListener('touchend', this.touchEnd);
      doc.addEventListener('touchcancel', this.touchCancel);
      doc.addEventListener('keydown', this.key, true);
      doc.addEventListener('scroll', this.scroll, true);
      doc.defaultView?.addEventListener('blur', this.cancel);
      this.labelMarkers();
    }
    marker(target: EventTarget | null) {
      return target && 'closest' in target ? (target as HTMLElement).closest<HTMLElement>('[data-composer-marker]') : null;
    }
    reference(element: HTMLElement | null) {
      if (!element || !this.view.contentDOM.contains(element)) return undefined;
      return this.view.state.field(composerReferences).find(reference => reference.id === element.dataset.composerReference && isComposerMarker(reference));
    }
    labelMarkers() {
      const objects = this.view.state.field(composerMarkerObjects);
      for (const element of this.view.contentDOM.querySelectorAll<HTMLElement>('[data-composer-marker]')) {
        const reference = this.reference(element), object = objects.find(object => object.id === (reference && composerMarkerObjectId(reference)));
        if (object) element.setAttribute('aria-label', `${object.label}${object.sourceLabel ? ` · ${object.sourceLabel}` : ''}`);
      }
    }
    down(event: PointerEvent) {
      if (event.pointerType === 'touch' || event.button !== 0 || this.view.composing || options.isComposing?.() || !this.view.state.facet(EditorView.editable)) return false;
      const element = this.marker(event.target), reference = this.reference(element);
      if (!element || !reference) return false;
      this.finish(false, false); this.suppressClick = false;
      // A new gesture can start immediately while the previous ghost is landing.
      this.settling?.remove(); this.settling = null; clearTimeout(this.settleTimer);
      const rect = element.getBoundingClientRect();
      this.press = { input: 'pointer', reference, element, pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
        offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, active: false, target: null };
      this.timer = setTimeout(() => this.lift(), MARKER_HOLD_MS);
      // Do not consume normal selection, focus or scroll before the hold is recognized.
      return false;
    }
    touchStart(event: TouchEvent) {
      if (event.touches.length !== 1 || this.view.composing || options.isComposing?.() || !this.view.state.facet(EditorView.editable)) return false;
      const touch = event.changedTouches[0], element = this.marker(event.target), reference = this.reference(element);
      if (!touch || !element || !reference) return false;
      this.finish(false, false); this.suppressClick = false;
      const rect = element.getBoundingClientRect();
      this.press = { input: 'touch', reference, element, pointer: touch.identifier, x: touch.clientX, y: touch.clientY, startX: touch.clientX, startY: touch.clientY,
        offsetX: touch.clientX - rect.left, offsetY: touch.clientY - rect.top, active: false, target: null };
      this.timer = setTimeout(() => this.lift(), MARKER_HOLD_MS);
      return false;
    }
    lift() {
      const press = this.press;
      if (!press || this.destroyed || this.view.composing || options.isComposing?.() || !this.view.state.selection.main.empty) { this.finish(false, false); return; }
      press.active = true; this.suppressClick = true;
      try { if (press.input === 'pointer') press.element.setPointerCapture(press.pointer); } catch { /* Detached DOM or unsupported touch capture. */ }
      const doc = this.view.dom.ownerDocument;
      const floating = doc.createElement('span');
      floating.className = 'cm-marker-floating'; floating.textContent = press.reference.text; floating.setAttribute('aria-hidden', 'true');
      const style = getComputedStyle(press.element);
      Object.assign(floating.style, { position: 'fixed', zIndex: '10000', pointerEvents: 'none', left: '0', top: '0', whiteSpace: 'nowrap',
        color: style.color, background: 'var(--surface, Canvas)', font: style.font, padding: '1px 3px', borderRadius: '4px',
        boxShadow: '0 4px 16px rgb(0 0 0 / 18%)', transition: 'box-shadow var(--motion-dur-snap) var(--motion-ease-snap)' });
      const caret = doc.createElement('span');
      caret.setAttribute('aria-hidden', 'true');
      Object.assign(caret.style, { position: 'fixed', zIndex: '9999', pointerEvents: 'none', width: '2px', background: 'var(--primary)', display: 'none' });
      doc.body.append(floating, caret); this.floating = floating; this.caret = caret;
      press.element.style.opacity = '0.35';
      this.schedule();
    }
    schedule() { if (!this.frame) this.frame = requestAnimationFrame(this.paint); }
    paint = (time: number) => {
      this.frame = 0;
      const press = this.press;
      if (!press?.active || !this.floating || !this.caret) return;
      const viewport = this.view.scrollDOM.getBoundingClientRect();
      const inside = press.x >= viewport.left && press.x <= viewport.right && press.y >= viewport.top && press.y <= viewport.bottom;
      const dt = this.previousFrame ? Math.min(time - this.previousFrame, 32) : 16; this.previousFrame = time;
      // Only the input's own scroll viewport is driven, never the conversation.
      const edge = Math.min(32, viewport.height / 4);
      let velocity = 0;
      if (inside && edge > 0) {
        if (press.y < viewport.top + edge) velocity = -Math.min(1, (viewport.top + edge - press.y) / edge);
        else if (press.y > viewport.bottom - edge) velocity = Math.min(1, (press.y - viewport.bottom + edge) / edge);
      }
      if (velocity) this.view.scrollDOM.scrollTop += velocity * dt * .45;
      const position = inside ? this.view.posAtCoords({ x: press.x, y: press.y }, false) : null;
      press.target = position === null ? null : snapMarkerPosition(this.view.state, position);
      const coords = press.target === null ? null : this.view.coordsAtPos(press.target);
      // Read geometry before writing floating layers. No editor state update on each frame.
      this.floating.style.transform = `translate(${press.x - press.offsetX}px, ${press.y - press.offsetY - 3}px)`;
      this.caret.style.display = coords ? 'block' : 'none';
      if (coords) Object.assign(this.caret.style, { left: `${coords.left}px`, top: `${coords.top}px`, height: `${coords.bottom - coords.top}px` });
      if (velocity) this.schedule();
    };
    move = (event: PointerEvent) => {
      const press = this.press;
      if (!press || press.input !== 'pointer' || press.pointer !== event.pointerId) return;
      press.x = event.clientX; press.y = event.clientY;
      if (!press.active) {
        if (Math.hypot(press.x - press.startX, press.y - press.startY) > 8) { this.suppressClick = true; this.finish(false, false); }
        return;
      }
      event.preventDefault(); this.schedule();
    };
    up = (event: PointerEvent) => {
      if (!this.press || this.press.input !== 'pointer' || this.press.pointer !== event.pointerId) return;
      if (this.press.active) { this.press.x = event.clientX; this.press.y = event.clientY; this.paint(performance.now()); event.preventDefault(); }
      this.finish(true, true);
    };
    // A nonpassive TouchEvent sensor can claim movement after a hold without touch-action:none
    // disabling pre-hold page scrolling. Pointer cancellation does not own this touch gesture.
    touchMove = (event: TouchEvent) => {
      const press = this.press; if (!press || press.input !== 'touch') return;
      const touch = Array.from(event.touches).find(touch => touch.identifier === press.pointer);
      if (!touch || event.touches.length !== 1) { this.finish(false, true); return; }
      press.x = touch.clientX; press.y = touch.clientY;
      if (!press.active) { if (Math.hypot(press.x - press.startX, press.y - press.startY) > 8) { this.suppressClick = true; this.finish(false, false); } return; }
      event.preventDefault(); this.schedule();
    };
    touchEnd = (event: TouchEvent) => {
      const press = this.press; if (!press || press.input !== 'touch') return;
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === press.pointer);
      if (!touch) return;
      if (press.active) { event.preventDefault(); press.x = touch.clientX; press.y = touch.clientY; this.paint(performance.now()); }
      this.finish(true, true);
    };
    touchCancel = () => { if (this.press?.input === 'touch') this.finish(false, true); };
    pointerCancel = () => { if (this.press?.input === 'pointer') this.finish(false, true); };
    cancel = () => this.finish(false, true);
    scroll = () => { if (this.press && !this.press.active) this.finish(false, false); else if (this.press) this.schedule(); };
    key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.press) { event.preventDefault(); event.stopPropagation(); this.finish(false, true); return; }

    };
    click(event: MouseEvent) {
      if (this.suppressClick) { this.suppressClick = false; event.preventDefault(); return true; }
      const reference = this.reference(this.marker(event.target));
      if (!reference || !this.view.state.selection.main.empty) return false;
      event.preventDefault(); options.onOpen(reference); return true;
    }
    finish(commit: boolean, animate: boolean) {
      clearTimeout(this.timer); this.timer = undefined;
      if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.previousFrame = 0;
      const press = this.press; this.press = null;
      if (!press) return;
      if (press.active) {
        try { if (press.input === 'pointer') press.element.releasePointerCapture(press.pointer); } catch { /* Already released. */ }
        press.element.style.opacity = '';
        const spec = commit && press.target !== null ? moveComposerMarker(this.view.state, press.reference.id, press.target) : null;
        if (spec) this.view.dispatch(spec);
        const current = this.view.state.field(composerReferences).find(reference => reference.id === press.reference.id);
        const destination = current && this.view.coordsAtPos(current.from);
        const floating = this.floating;
        if (floating && destination && animate && this.view.dom.ownerDocument.documentElement.dataset.motion !== 'off') {
          const reduced = this.view.dom.ownerDocument.documentElement.dataset.motion === 'reduced';
          floating.style.transition = reduced ? 'opacity var(--motion-dur-snap) var(--motion-ease-snap)' : 'transform var(--motion-dur-glide) var(--motion-ease-glide), opacity var(--motion-dur-glide) var(--motion-ease-glide)';
          floating.style.transform = `translate(${destination.left}px, ${destination.top}px)`; floating.style.opacity = '0';
          this.settling = floating;
          this.settleTimer = setTimeout(() => { floating.remove(); if (this.settling === floating) this.settling = null; }, 600);
        } else floating?.remove();
      }
      this.floating = null; this.caret?.remove(); this.caret = null;
    }
    update(update: ViewUpdate) {
      if (this.press && (update.docChanged || (update.selectionSet && !update.state.selection.main.empty))) this.finish(false, true);
      if (update.docChanged || update.viewportChanged || update.transactions.some(transaction => transaction.effects.length)) queueMicrotask(() => { if (!this.destroyed) this.labelMarkers(); });
    }
    destroy() {
      this.destroyed = true; this.finish(false, false); this.settling?.remove(); clearTimeout(this.settleTimer);
      const doc = this.view.dom.ownerDocument;
      doc.removeEventListener('pointermove', this.move); doc.removeEventListener('pointerup', this.up); doc.removeEventListener('pointercancel', this.pointerCancel);
      doc.removeEventListener('touchmove', this.touchMove); doc.removeEventListener('touchend', this.touchEnd); doc.removeEventListener('touchcancel', this.touchCancel);
      doc.removeEventListener('keydown', this.key, true); doc.removeEventListener('scroll', this.scroll, true); doc.defaultView?.removeEventListener('blur', this.cancel);
    }
  }, { eventHandlers: { pointerdown(event) { return this.down(event); }, touchstart(event) { return this.touchStart(event); }, contextmenu(event) { if (!this.press?.active) return false; event.preventDefault(); return true; }, click(event) { return this.click(event); } } });
}
