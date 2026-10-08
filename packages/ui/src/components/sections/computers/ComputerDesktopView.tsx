import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  handbackDesktop,
  sendDesktopInput,
  subscribeDesktopStream,
  takeoverDesktop,
  type DesktopStreamEvent,
} from '@/lib/computers';
import type { ComputerControlState, ComputerDesktop, ComputerDesktopFrame } from '@varin/protocol';
import { desktopKey, desktopPoint } from '@/lib/computerInput';
import { VncDesktop } from './VncDesktop';
import { ComputerFeedback, type ComputerFeedbackHandle } from './ComputerFeedback';

const newViewerId = () => `viewer-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/**
 * The desktop view surface (BC5/BC8): one EventSource subscription feeding
 * frames + control events, pointer/key forwarding while this viewer holds
 * control. Works inline (workbench tab) or inside `ComputerDesktopView`'s
 * dialog. Unmounting closes only this subscription — never the task.
 */
export function ComputerDesktopPane({ desktop }: { desktop: ComputerDesktop }) {
  const { t } = useI18n();
  const [viewerId] = React.useState(newViewerId);
  const [frameUrl, setFrameUrl] = React.useState<string | null>(null);
  const [frame, setFrame] = React.useState<ComputerDesktopFrame | null>(null);
  const [control, setControl] = React.useState<ComputerControlState | null>(null);
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const feedback = React.useRef<ComputerFeedbackHandle>(null);
  const [textDraft, setTextDraft] = React.useState('');
  const frameRef = React.useRef<HTMLImageElement | null>(null);
  const vncRef = React.useRef<HTMLDivElement | null>(null);
  const useVnc = desktop.media?.kind === 'vnc';
  const [vncStatus, setVncStatus] = React.useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const vncGeometry = React.useCallback((width: number, height: number) => {
    setFrame({ mime: 'image/png', base64: '', capturedAt: '', bounds: { x: 0, y: 0, width, height } });
  }, []);
  const vncConnected = React.useCallback((connected: boolean) => setVncStatus(connected ? 'connected' : 'disconnected'), []);
  const inputTail = React.useRef<Promise<unknown>>(Promise.resolve());
  const inputGeneration = React.useRef(0);
  const composing = React.useRef(false);
  const pointers = React.useRef(new Map<number, { x: number; y: number; button: 'left' | 'right' | 'middle' }>());

  React.useEffect(() => {
    setFrameUrl(null);
    setFrame(null);
    setControl(null);
    setStreamError(null);
    setInputError(null);
    feedback.current?.clear();
    const source = subscribeDesktopStream(desktop.id, viewerId, !useVnc);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as DesktopStreamEvent;
        if (event.type === 'frame') {
          setFrame(event.frame);
          setFrameUrl(`data:${event.frame.mime};base64,${event.frame.base64}`);
          setStreamError(null);
        } else if (event.type === 'control') {
          // The next gesture may arrive in this same SSE batch, before React
          // commits the new control owner. Update the imperative fence now.
          feedback.current?.setEnabled(event.control.owner === 'agent');
          setControl(event.control);
        } else if (event.type === 'gesture') {
          feedback.current?.show(event.gesture);
        } else if (event.type === 'error') {
          setStreamError(event.error);
        }
      } catch {
        // A malformed stream event is dropped, not fatal.
      }
    };
    source.onerror = () => setStreamError(t('settings.computers.view.streamLost'));
    return () => {
      inputGeneration.current += 1;
      // Closing the page closes only this subscription — never the task.
      source.close();
    };
  }, [desktop.id, viewerId, t, useVnc]);

  const weHoldControl = control?.owner === 'human' && control.holderId === viewerId;
  const mayRelease = weHoldControl && control.reachable && !control.transitioning;
  const canInput = mayRelease && !streamError && (!useVnc || vncStatus === 'connected');
  React.useEffect(() => { inputGeneration.current += 1; }, [control?.automationEpoch, canInput]);
  React.useEffect(() => { pointers.current.clear(); }, [control?.automationEpoch]);
  const controlPending = control?.owner === 'human' && control.holderId !== viewerId;

  const takeover = async () => {
    setBusy(true);
    setInputError(null);
    try {
      const result = await takeoverDesktop(desktop.id, viewerId);
      setControl(result.control);
      setStreamError(null);
    } catch (cause) {
      setInputError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handback = async () => {
    setBusy(true);
    setInputError(null);
    try {
      const result = await handbackDesktop(desktop.id, viewerId);
      setControl(result.control);
    } catch (cause) {
      setInputError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Translate a pointer event on the image into absolute desktop pixels. */
  const pointFor = (event: React.MouseEvent): { x: number; y: number } | null => {
    const img = useVnc ? vncRef.current?.querySelector('canvas') : frameRef.current;
    if (!img || !frame) return null;
    return desktopPoint(frame.bounds, img.getBoundingClientRect(), event.clientX, event.clientY);
  };

  const emitInput = React.useCallback((input: Parameters<typeof sendDesktopInput>[2]) => {
    if (!canInput && !(mayRelease && input.kind === 'up')) return Promise.resolve(false);
    const generation = inputGeneration.current;
    // Preserve key/drag ordering even if the browser opens concurrent HTTP requests.
    const pending = inputTail.current.then(async () => {
      if (generation !== inputGeneration.current) return false;
      const result = await sendDesktopInput(desktop.id, viewerId, input, control.automationEpoch);
      if (!result.accepted) throw new Error(result.detail ?? 'Desktop input was not accepted');
      return true;
    }).catch((cause) => {
      setInputError(cause instanceof Error ? cause.message : String(cause));
      return false;
    });
    inputTail.current = pending;
    return pending;
  }, [canInput, mayRelease, desktop.id, viewerId, control?.automationEpoch]);

  React.useEffect(() => {
    if (!useVnc || vncStatus === 'connected' || !mayRelease) return;
    // The RFB viewer can disconnect during a drag. Release only input owned by
    // this viewer through the normal, epoch-checked Host lane.
    for (const held of pointers.current.values()) void emitInput({ kind: 'up', ...held });
    pointers.current.clear();
  }, [useVnc, vncStatus, mayRelease, emitInput]);

  const onPointer = (event: React.PointerEvent<HTMLElement>) => {
    const releasing = ['pointerup', 'pointercancel', 'lostpointercapture'].includes(event.type);
    if (!canInput && !(releasing && mayRelease)) return;
    const held = pointers.current.get(event.pointerId);
    if (event.type !== 'pointerdown' && event.type !== 'pointermove' && !held) return;
    const point = event.type === 'lostpointercapture' ? held : pointFor(event);
    if (!point) return;
    const button = held?.button ?? (event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left');
    event.preventDefault();
    if (event.type === 'pointerdown') {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (event.type === 'pointerdown' || (event.type === 'pointermove' && held)) pointers.current.set(event.pointerId, { ...point, button });
    else pointers.current.delete(event.pointerId);
    emitInput({
      kind: event.type === 'pointerdown' ? 'down' : event.type === 'pointermove' ? 'move' : 'up',
      ...point,
      button,
    });
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!canInput) return;
    const point = pointFor(event);
    if (!point) return;
    const direction = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? (event.deltaX > 0 ? 'right' : 'left')
      : (event.deltaY > 0 ? 'down' : 'up');
    emitInput({ kind: 'scroll', ...point, direction, pages: Math.abs(Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) / 120 });
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (!canInput || composing.current || event.nativeEvent.isComposing) return;
    const input = desktopKey(event);
    if (!input) return;
    event.preventDefault();
    emitInput(input);
  };

  const controlLabel = !control ? t('settings.computers.view.control.unknown')
    : control.owner === 'agent' ? t('settings.computers.view.control.agent')
      : weHoldControl ? t('settings.computers.view.control.you')
        : control.reachable ? t('settings.computers.view.control.otherHuman')
          : t('settings.computers.view.control.pendingHuman');
  const inputHandlers: React.HTMLAttributes<HTMLElement> = {
    tabIndex: canInput ? 0 : -1, onKeyDown: onKey,
    onPointerDown: onPointer, onPointerUp: onPointer, onPointerCancel: onPointer, onLostPointerCapture: onPointer,
    onPointerMove: onPointer,
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event) => { composing.current = false; if (event.data) emitInput({ kind: 'text', text: event.data }); },
    onPaste: (event) => { if (canInput) { event.preventDefault(); emitInput({ kind: 'text', text: event.clipboardData.getData('text/plain') }); } },
    onWheel, onContextMenu: (event) => event.preventDefault(),
  };

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <div className="flex items-center justify-between gap-3">
        <span className="typography-meta text-muted-foreground" data-control={control?.owner ?? 'unknown'}>
          {controlLabel}
          {frame?.capturedAt ? <time className="ml-2" dateTime={frame.capturedAt}>{new Date(frame.capturedAt).toLocaleTimeString()}</time> : null}
          {control && control.owner === 'human' && !control.reachable ? ` — ${t('settings.computers.view.control.reconnecting')}` : ''}
        </span>
        <div className="flex items-center gap-2">
          {control?.owner === 'agent' ? (
            <Button size="sm" disabled={busy || control.transitioning} onClick={() => { void takeover(); }}>
              {t('settings.computers.view.takeover')}
            </Button>
          ) : null}
          {weHoldControl ? (
            <Button size="sm" variant="outline" disabled={busy || control?.transitioning} onClick={() => { void handback(); }}>
              {t('settings.computers.view.handback')}
            </Button>
          ) : null}
          {controlPending ? (
            <Button size="sm" disabled={busy || control?.transitioning} onClick={() => { void takeover(); }}>
              {t('settings.computers.view.reclaim')}
            </Button>
          ) : null}
        </div>
      </div>
      {streamError ? <p role="alert" className="typography-meta text-destructive">{streamError}</p> : null}
      {useVnc && vncStatus === 'disconnected' ? <p role="alert" className="typography-meta text-destructive">{t('settings.computers.view.streamLost')}</p> : null}
      {inputError ? <p role="alert" className="typography-meta text-destructive">{inputError}</p> : null}
      <div className="relative rounded-lg border border-border/60 bg-black/80 overflow-hidden flex items-center justify-center min-h-[240px]">
        {useVnc ? <div {...inputHandlers} className="h-[60vh] w-full select-none touch-none" aria-label={desktop.label}>
          <VncDesktop ref={vncRef} desktopId={desktop.id} onGeometry={vncGeometry} onConnected={vncConnected} />
        </div> : frameUrl ? (
          <img
            ref={frameRef}
            src={frameUrl}
            alt={desktop.label}
            draggable={false}
            className="max-h-[70vh] max-w-full w-auto select-none touch-none"
            {...inputHandlers}
          />
        ) : (
          <p role="status" className="typography-meta text-muted-foreground p-8">{t('settings.computers.view.waiting')}</p>
        )}
        <ComputerFeedback ref={feedback} bounds={frame?.bounds} upscale={useVnc} disabled={control?.owner !== 'agent' || Boolean(streamError)} />
      </div>
      {weHoldControl ? (
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!textDraft || !canInput) return;
          const submitted = textDraft;
          void emitInput({ kind: 'text', text: submitted }).then((accepted) => {
            if (accepted) setTextDraft((current) => current === submitted ? '' : current);
          });
        }}>
          <textarea className="min-w-0 flex-1 rounded border bg-background p-2" rows={2}
            value={textDraft} onChange={(event) => setTextDraft(event.target.value)}
            aria-label={t('settings.computers.view.textInput')} placeholder={t('settings.computers.view.textInput')} />
          <Button type="submit" disabled={!canInput || !textDraft}>{t('settings.computers.view.sendText')}</Button>
        </form>
      ) : null}
    </div>
  );
}

/** Dialog wrapper for the settings surface (BC5 entry). */
export function ComputerDesktopView({ desktop, open, onOpenChange }: {
  desktop: ComputerDesktop;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl" tabIndex={-1}>
        <DialogHeader>
          <DialogTitle>{desktop.label}</DialogTitle>
        </DialogHeader>
        {open ? <ComputerDesktopPane key={desktop.id} desktop={desktop} /> : null}
      </DialogContent>
    </Dialog>
  );
}
