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
import type { ComputerControlState, ComputerDesktop } from '@varin/protocol';

const newViewerId = () => `viewer-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/**
 * Shared desktop view (BC5). Subscribing mounts an EventSource on the Host
 * frame service; unmounting closes it — the task and desktop keep running.
 * Taking over flips the Host-side control owner to this viewer; every click
 * and keypress then travels through the same serialized lane the agent uses.
 */
export function ComputerDesktopView({ desktop, open, onOpenChange }: {
  desktop: ComputerDesktop;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [viewerId] = React.useState(newViewerId);
  const [frameUrl, setFrameUrl] = React.useState<string | null>(null);
  const [control, setControl] = React.useState<ComputerControlState | null>(null);
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const frameRef = React.useRef<HTMLImageElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const source = subscribeDesktopStream(desktop.id, viewerId);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as DesktopStreamEvent;
        if (event.type === 'frame') {
          setFrameUrl(`data:${event.frame.mime};base64,${event.frame.base64}`);
          setStreamError(null);
        } else if (event.type === 'control') {
          setControl(event.control);
        } else if (event.type === 'error') {
          setStreamError(event.error);
        }
      } catch {
        // A malformed stream event is dropped, not fatal.
      }
    };
    source.onerror = () => setStreamError(t('settings.computers.view.streamLost'));
    return () => {
      // Closing the page closes only this subscription — never the task.
      source.close();
    };
  }, [open, desktop.id, viewerId, t]);

  const weHoldControl = control?.owner === 'human' && control.holderId === viewerId;
  const controlPending = control?.owner === 'human' && control.holderId !== viewerId;

  const takeover = async () => {
    setBusy(true);
    try {
      const result = await takeoverDesktop(desktop.id, viewerId);
      setControl(result.control);
      setStreamError(null);
    } catch (cause) {
      setStreamError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handback = async () => {
    setBusy(true);
    try {
      const result = await handbackDesktop(desktop.id, viewerId);
      setControl(result.control);
    } catch (cause) {
      setStreamError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Translate a pointer event on the image into absolute desktop pixels. */
  const desktopPoint = (event: React.MouseEvent): { x: number; y: number } | null => {
    const img = frameRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    return {
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
    };
  };

  const emitInput = (input: Parameters<typeof sendDesktopInput>[2]) => {
    if (!weHoldControl) return;
    void sendDesktopInput(desktop.id, viewerId, input).catch((cause) => {
      setStreamError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const onMouse = (event: React.MouseEvent) => {
    if (!weHoldControl) return;
    const point = desktopPoint(event);
    if (!point) return;
    event.preventDefault();
    emitInput({
      kind: event.type === 'mousedown' ? 'down' : 'up',
      ...point,
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
    });
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!weHoldControl) return;
    const point = desktopPoint(event as unknown as React.MouseEvent);
    if (!point) return;
    const direction = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? (event.deltaX > 0 ? 'right' : 'left')
      : (event.deltaY > 0 ? 'down' : 'up');
    emitInput({ kind: 'scroll', ...point, direction, pages: Math.max(0.2, Math.min(3, Math.abs(event.deltaY + event.deltaX) / 120)) });
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (!weHoldControl) return;
    event.preventDefault();
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push('ctrl');
    if (event.altKey) modifiers.push('alt');
    if (event.shiftKey) modifiers.push('shift');
    if (event.metaKey) modifiers.push('cmd');
    const key = event.key === ' ' ? 'space' : event.key;
    if (key.length === 1) {
      emitInput({ kind: 'text', text: key });
      return;
    }
    emitInput({ kind: 'key', key: [...modifiers, key.toLowerCase()].join('+') });
  };

  const controlLabel = !control ? t('settings.computers.view.control.unknown')
    : control.owner === 'agent' ? t('settings.computers.view.control.agent')
      : weHoldControl ? t('settings.computers.view.control.you')
        : control.reachable ? t('settings.computers.view.control.otherHuman')
          : t('settings.computers.view.control.pendingHuman');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl" onKeyDown={weHoldControl ? onKey : undefined} tabIndex={-1}>
        <DialogHeader>
          <DialogTitle>{desktop.label}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3">
          <span className="typography-meta text-muted-foreground" data-control={control?.owner ?? 'unknown'}>
            {controlLabel}
            {control && control.owner === 'human' && !control.reachable ? ` — ${t('settings.computers.view.control.reconnecting')}` : ''}
          </span>
          <div className="flex items-center gap-2">
            {control?.owner === 'agent' ? (
              <Button size="sm" disabled={busy} onClick={() => { void takeover(); }}>
                {t('settings.computers.view.takeover')}
              </Button>
            ) : null}
            {weHoldControl ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { void handback(); }}>
                {t('settings.computers.view.handback')}
              </Button>
            ) : null}
            {controlPending ? (
              <Button size="sm" disabled={busy} onClick={() => { void takeover(); }}>
                {t('settings.computers.view.reclaim')}
              </Button>
            ) : null}
          </div>
        </div>
        {streamError ? <p role="alert" className="typography-meta text-destructive">{streamError}</p> : null}
        <div className="rounded-lg border border-border/60 bg-black/80 overflow-hidden flex items-center justify-center min-h-[240px]">
          {frameUrl ? (
            <img
              ref={frameRef}
              src={frameUrl}
              alt={desktop.label}
              draggable={false}
              className="max-h-[70vh] w-auto select-none"
              onMouseDown={onMouse}
              onMouseUp={onMouse}
              onWheel={onWheel}
              onContextMenu={(event) => event.preventDefault()}
            />
          ) : (
            <p role="status" className="typography-meta text-muted-foreground p-8">{t('settings.computers.view.waiting')}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
