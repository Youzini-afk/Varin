import type { PiSessionViewState } from '@/stores/usePiSessionStore';
import { liveUserTurnId, persistedUserTurnId } from '@/lib/pi-runtime/piTimelineScrollState';

type Source = { left: number; top: number; width: number; height: number; radius: string };
type Transfer = {
  sessionId: string;
  source: Source | null;
  turnId?: string;
  flight?: { target: HTMLElement; opacity: string; overlay: HTMLElement; animation: Animation };
};

/** View-local paint projections. No prompt, queue, history or scroll ownership. */
export class PiMessageHandoff {
  private root: HTMLElement | null = null;
  private sessionId: string | null = null;
  private runtimeKey = '';
  private enabled = false;
  private reduced = false;
  private transfers = new Map<string, Transfer>();
  private queueSources = new Map<string, Source | null>();
  private observer: MutationObserver | null = null;
  private frame: number | null = null;
  private paintFrame: number | null = null;

  setRoot = (root: HTMLElement | null): void => {
    if (root === this.root) return;
    this.observer?.disconnect();
    this.observer = null;
    this.root?.removeEventListener('scroll', this.interrupt, true);
    for (const [id, transfer] of this.transfers) if (transfer.flight) this.finish(id);
    this.root = root;
    if (root) {
      root.addEventListener('scroll', this.interrupt, { capture: true, passive: true });
      this.watch();
    }
  };

  select(runtimeKey: string, sessionId: string | null, enabled: boolean, reduced: boolean): void {
    const changed = this.runtimeKey !== runtimeKey || this.sessionId !== sessionId;
    if (changed) {
      for (const [id, transfer] of this.transfers) {
        if (this.runtimeKey !== runtimeKey || transfer.sessionId !== sessionId) this.finish(id);
      }
      this.queueSources.clear();
    }
    this.runtimeKey = runtimeKey;
    this.sessionId = sessionId;
    this.enabled = enabled;
    this.reduced = reduced;
    if (!enabled || reduced) this.cancel();
  }

  captureDraft(): Source | null {
    return this.capture(this.root?.querySelector<HTMLElement>('[data-pi-composer-input-frame]') ?? null);
  }

  submit(id: string, sessionId: string, source: Source | null): void {
    if (!this.enabled || this.reduced) return;
    this.transfers.set(`submit:${id}`, { sessionId, source });
    this.watch();
  }

  cancelSubmission(id: string): void { this.finish(`submit:${id}`); }

  observe(next: PiSessionViewState | undefined, previous?: PiSessionViewState): void {
    if (!this.enabled || this.reduced || !next || next.sessionId !== this.sessionId) return;
    for (const [id, transfer] of this.transfers) {
      if (!id.startsWith('submit:')) continue;
      const submissionId = id.slice('submit:'.length);
      if (next.submission?.id === submissionId && next.submission.status === 'failed') {
        this.finish(id);
      } else if (next.view?.newTurn?.submissionId === submissionId) {
        transfer.turnId = next.view.newTurn.turnId;
      } else if (transfer.turnId && next.submission?.id !== submissionId) {
        this.finish(id);
      }
    }
    const event = next.lastAgentEvent;
    // Opening history or remounting a shell must never replay an old arrival.
    if (previous && event && event !== previous.lastAgentEvent) {
      if (event.type === 'queue_update') {
        const remaining = new Set(event.queuedMessages.map(message => message.id));
        for (const message of previous.snapshot?.queuedMessages ?? []) {
          if (remaining.has(message.id)) continue;
          const row = this.root?.querySelector<HTMLElement>(`[data-pi-queued-message="${CSS.escape(message.id)}"]`);
          this.queueSources.set(message.id, this.capture(row?.querySelector<HTMLElement>('p') ?? row ?? null));
        }
      } else if (event.type === 'message_start' && event.message.role === 'user' && event.queuedMessageId) {
        const id = `queue:${event.queuedMessageId}`;
        this.transfers.set(id, {
          sessionId: next.sessionId,
          source: this.queueSources.get(event.queuedMessageId) ?? null,
          turnId: liveUserTurnId(event.message.timestamp),
        });
        this.queueSources.delete(event.queuedMessageId);
      } else if (event.type === 'entry_appended' && event.entry.type === 'message' && event.entry.message.role === 'user' && event.queuedMessageId) {
        const transfer = this.transfers.get(`queue:${event.queuedMessageId}`);
        if (transfer) transfer.turnId = persistedUserTurnId(event.entry.id);
      } else if (event.type === 'agent_settled') {
        this.queueSources.clear();
      }
    }
    this.watch();
  }

  dispose(): void {
    this.cancel();
    this.setRoot(null);
  }

  private bounds(): DOMRect | null {
    const root = this.root;
    if (!root?.isConnected || root.closest('[inert], [data-varin-workbench-shell-staging]')) return null;
    const rect = root.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  private capture(element: HTMLElement | null): Source | null {
    const bounds = this.bounds();
    if (!element || !bounds || !this.enabled || this.reduced) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, bounds.left, 0);
    const top = Math.max(rect.top, bounds.top, 0);
    const right = Math.min(rect.right, bounds.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, bounds.bottom, window.innerHeight);
    if (right <= left || bottom <= top) return null;
    return { left, top, width: right - left, height: bottom - top, radius: getComputedStyle(element).borderRadius };
  }

  private target(transfer: Transfer): HTMLElement | null {
    if (!transfer.turnId || transfer.sessionId !== this.sessionId) return null;
    return this.root?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(transfer.turnId)}"] [data-pi-user-message] > div`) ?? null;
  }

  private watch(): void {
    if (!this.root || !this.transfers.size) return;
    if (!this.observer && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(this.root, { childList: true, subtree: true });
      window.addEventListener('resize', this.interrupt);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== null || this.paintFrame !== null) return;
    // Let the existing virtual list establish its new-turn anchor first.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paintFrame = requestAnimationFrame(() => {
        this.paintFrame = null;
        for (const [id, transfer] of this.transfers) {
          const target = this.target(transfer);
          if (!target) continue;
          if (transfer.flight) {
            // A native entry replaces its optimistic/live node without replaying the motion.
            if (transfer.flight.target !== target) {
              transfer.flight.target.style.opacity = transfer.flight.opacity;
              transfer.flight.opacity = target.style.opacity;
              transfer.flight.target = target;
              target.style.opacity = '0';
            }
          } else this.fly(id, transfer, target);
        }
      });
    });
  }

  private fly(id: string, transfer: Transfer, target: HTMLElement): void {
    const bounds = this.bounds();
    const destination = this.capture(target);
    const viewport = target.closest('.overlay-scrollbar-container')?.getBoundingClientRect();
    if (!bounds || !destination || (viewport && (destination.top >= viewport.bottom || destination.top + destination.height <= viewport.top))) {
      this.finish(id);
      return;
    }
    if (!transfer.source || typeof target.animate !== 'function') {
      // A missing/offscreen source still gets a small arrival at its real destination.
      if (typeof target.animate === 'function') target.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180 });
      this.finish(id);
      return;
    }
    const source = transfer.source;
    const overlay = document.createElement('div');
    overlay.className = 'pi-message-handoff';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.inert = true;
    const paint = target.cloneNode(true) as HTMLElement;
    paint.removeAttribute('id');
    for (const element of paint.querySelectorAll('[id]')) element.removeAttribute('id');
    const style = getComputedStyle(target);
    Object.assign(paint.style, {
      width: `${target.getBoundingClientRect().width}px`, margin: '0',
      font: style.font, color: style.color, opacity: '1',
    });
    overlay.append(paint);
    Object.assign(overlay.style, {
      left: `${destination.left - bounds.left}px`, top: `${destination.top - bounds.top}px`,
      width: `${destination.width}px`, height: `${destination.height}px`, borderRadius: destination.radius,
      background: style.backgroundColor,
    });
    this.root!.append(overlay);
    const opacity = target.style.opacity;
    target.style.opacity = '0';
    const animation = overlay.animate([
      { transform: `translate(${source.left - destination.left}px, ${source.top - destination.top}px)`,
        width: `${source.width}px`, height: `${source.height}px`, borderRadius: source.radius, opacity: 0.75 },
      { transform: 'none', width: `${destination.width}px`, height: `${destination.height}px`, borderRadius: destination.radius, opacity: 1 },
    ], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    transfer.flight = { target, opacity, overlay, animation };
    void animation.finished.then(() => this.finish(id), () => this.finish(id));
  }

  private interrupt = (): void => { for (const [id, transfer] of this.transfers) if (transfer.flight) this.finish(id); };

  private finish(id: string): void {
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    this.transfers.delete(id);
    if (transfer.flight) {
      transfer.flight.target.style.opacity = transfer.flight.opacity;
      transfer.flight.animation.cancel();
      transfer.flight.overlay.remove();
    }
    if (!this.transfers.size) {
      this.observer?.disconnect();
      this.observer = null;
      window.removeEventListener('resize', this.interrupt);
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      if (this.paintFrame !== null) cancelAnimationFrame(this.paintFrame);
      this.frame = this.paintFrame = null;
    }
  }

  private cancel(): void {
    for (const id of this.transfers.keys()) this.finish(id);
    this.queueSources.clear();
  }
}
