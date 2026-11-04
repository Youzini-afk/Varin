import type { BrowserFrameInfo, BrowserPage } from '@varin/protocol';
import { DESKTOP_BROWSER_INSPECT_SCRIPT, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT } from './preview/browser-view';

/** Keep clipboard shortcuts local. Forwarding them would access the device's
 * clipboard, not the viewer's, and cancelling keydown suppresses paste/copy. */
export function isBrowserClipboardShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && ['c', 'v'].includes(event.key.toLowerCase());
}

export function browserFrameMatchesControl(page: BrowserPage | undefined, frame: BrowserFrameInfo | undefined, streamId: string): boolean {
  return Boolean(page?.agentPaused && page.controlViewerId === streamId && frame?.streamId === streamId
    && frame.pageId === page.pageId && frame.pageGeneration === page.generation && frame.controlEpoch === page.controlEpoch);
}

export const BROWSER_SELECTION_SCRIPT = `(() => {
  let doc = document;
  let active = doc.activeElement;
  while (active) {
    if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
    if (active.tagName === 'IFRAME') {
      try { if (active.contentDocument) { doc = active.contentDocument; active = doc.activeElement; continue; } } catch {}
    }
    break;
  }
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    if (active.type === 'password') return '';
    if (typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
  }
  return String(doc.getSelection() || '');
})()`;

export const BROWSER_POSITION_SCRIPT = '({x:scrollX,y:scrollY})';
export function browserPosition(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object') return;
  const point = value as { x?: unknown; y?: unknown };
  if (typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)) return { x: point.x, y: point.y };
}

/** Start the clipboard write during the copy gesture. Safari, in particular,
 * preserves user activation for a promised ClipboardItem, not a later write. */
export async function copyBrowserSelection(read: () => Promise<string>, clipboard: Pick<Clipboard, 'write' | 'writeText'>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && clipboard.write) {
    await clipboard.write([new ClipboardItem({ 'text/plain': read().then(text => new Blob([text], { type: 'text/plain' })) })]);
  } else {
    await clipboard.writeText(await read());
  }
}

/** Serialize metrics changes and collapse intermediate layouts. Do not repeat a
 * failed resize: its effect may be unknown and it changes the control epoch. */
export function createBrowserResizeQueue(resize: (width: number, height: number) => Promise<unknown>, failed: (error: unknown) => void) {
  let active = false, stopped = false, last = '';
  let pending: { width: number; height: number } | undefined;
  const drain = async () => {
    if (active || stopped) return;
    active = true;
    try {
      while (pending && !stopped) {
        const next = pending; pending = undefined;
        await resize(next.width, next.height);
      }
    } catch (error) { pending = undefined; stopped = true; failed(error); }
    finally { active = false; }
  };
  return {
    update(width: number, height: number) {
      width = Math.round(width); height = Math.round(height);
      if (stopped || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
      const key = `${width}:${height}`; if (key === last) return;
      last = key; pending = { width, height }; void drain();
    },
    stop() { stopped = true; pending = undefined; },
  };
}

/** Browsers differ on whether the final input precedes or follows compositionend.
 * Send one commit, never the provisional local textarea value a second time. */
export function createBrowserTextInput(send: (text: string) => void) {
  let composing = false, committed: string | undefined;
  return {
    start() { composing = true; committed = undefined; },
    end(text: string) { if (!composing) return; composing = false; committed = text; if (text) send(text); },
    input(text: string, inputType: string, isComposing: boolean) {
      if (composing || isComposing) return;
      const duplicate = committed === text && ['insertCompositionText', 'insertFromComposition', 'insertText'].includes(inputType);
      committed = undefined;
      if (text && !duplicate) send(text);
    },
    key() { if (!composing) committed = undefined; },
    reset() { composing = false; committed = undefined; },
  };
}

/** A late cancellation/installation may never cancel another viewer or a newer
 * inspection. One small page-local slot tracks this viewer's current attempt. */
export function browserInspectorScripts(viewerId: string, sequence: number) {
  const key = JSON.stringify(`__varinInspector_${viewerId}`);
  const substitute = (script: string) => script.trim().replace(/;$/u, '')
    .replaceAll('window.__varinDesktopBrowserCancelInspect', `window[${JSON.stringify(`__varinInspectorCancel_${viewerId}`)}]`)
    .replaceAll('__varin_desktop_browser_overlay', `__varin_browser_overlay_${viewerId}`);
  return {
    start: `(() => {
      const previous = window[${key}];
      if (previous && (previous.sequence > ${sequence} || previous.sequence === ${sequence} && previous.cancelled)) return null;
      window[${key}] = { sequence: ${sequence}, cancelled: false };
      return (${substitute(DESKTOP_BROWSER_INSPECT_SCRIPT)}).then(target => target ? ({ target, position: { x: scrollX, y: scrollY }, url: location.href }) : null);
    })()`,
    cancel: `(() => {
      const previous = window[${key}];
      if (previous && previous.sequence > ${sequence}) return;
      (${substitute(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT)});
      window[${key}] = { sequence: ${sequence}, cancelled: true };
    })()`,
  };
}
