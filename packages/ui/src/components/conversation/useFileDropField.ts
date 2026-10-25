import React from 'react';
import { collectDroppedFiles } from '@/components/chat/composer/attachments/dataTransfer';
import { documentMotionLevel } from '@/lib/motion/preference';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';

/**
 * The drop field (docs/design/motion-and-interaction.md §3.11, drag and drop). While files from the
 * system are dragged over a conversation, a faint lattice of the Workbench switch's cells rises over
 * it and the cells near the pointer brighten, trailing it slightly; anywhere in the conversation takes
 * the drop. Dropping sends a brightening ripple out from the drop point as the field fades.
 *
 * One Canvas, drawn only while the field is visible or fading. The composer frame keeps handling the
 * drops that land on it; the field takes the rest of the conversation.
 */

const CELL_PX = 44;
const GLOW_RADIUS_PX = 170;
const FOLLOW_TAU_MS = 70;
const FADE_IN_MS = 160;
const FADE_OUT_MS = 110;
const RIPPLE_MS = 300;

/** Only files from outside: an internal drag (a path from the file tree) has its own targets. */
const carriesSystemFiles = (event: DragEvent): boolean => (
  Array.from(event.dataTransfer?.types ?? []).includes('Files')
);

/** 0 far from the pointer, 1 under it; smooth at both ends. */
export const dropFieldGlow = (distance: number, radius: number): number => {
  if (radius <= 0) return 0;
  const t = Math.max(0, 1 - distance / radius);
  return t * t * (3 - 2 * t);
};

interface FieldState {
  visible: boolean;
  opacity: number;
  pointer: { x: number; y: number } | null;
  shown: { x: number; y: number } | null;
  ripple: { x: number; y: number; at: number } | null;
}

export function useFileDropField(
  anchor: React.RefObject<HTMLElement | null>,
  options: { disabled: boolean; onFiles: (files: File[]) => void },
): void {
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    const frame = anchor.current;
    const region = frame?.closest<HTMLElement>('.regular-chat-view') ?? frame?.parentElement ?? null;
    if (!frame || !region) return;
    const doc = region.ownerDocument;
    let canvas: HTMLCanvasElement | null = null;
    let context: CanvasRenderingContext2D | null = null;
    let ink = 'rgb(128, 128, 128)';
    let size = { width: 0, height: 0, ratio: 1 };
    let depth = 0;
    let handle: FrameHandle | null = null;
    let last = 0;
    const state: FieldState = { visible: false, opacity: 0, pointer: null, shown: null, ripple: null };

    const ensureCanvas = (): CanvasRenderingContext2D | null => {
      if (!canvas) {
        canvas = doc.createElement('canvas');
        canvas.className = 'file-drop-field';
        canvas.setAttribute('aria-hidden', 'true');
        context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      }
      // Without a 2D context there is nothing to draw; the drop itself still works.
      if (!context) return null;
      if (!canvas.isConnected) region.append(canvas);
      const bounds = region.getBoundingClientRect();
      const ratio = Math.min(2, doc.defaultView?.devicePixelRatio || 1);
      if (bounds.width !== size.width || bounds.height !== size.height || ratio !== size.ratio) {
        size = { width: bounds.width, height: bounds.height, ratio };
        canvas.width = Math.max(1, Math.round(bounds.width * ratio));
        canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      }
      // The ink is the theme's foreground, resolved the way CSS resolves it.
      ink = doc.defaultView?.getComputedStyle?.(canvas).color || ink;
      return context;
    };

    const draw = (now: number): void => {
      const ctx = context;
      if (!ctx || !canvas) return;
      const level = documentMotionLevel();
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      // Opacity and the trailing glow ease toward where they are going.
      const fade = state.visible ? FADE_IN_MS : FADE_OUT_MS;
      const step = level === 'off' ? 1 : Math.min(1, dt / fade);
      state.opacity += ((state.visible ? 1 : 0) - state.opacity) * (state.visible ? step : Math.min(1, step * 1.6));
      if (Math.abs((state.visible ? 1 : 0) - state.opacity) < 0.01) state.opacity = state.visible ? 1 : 0;
      if (state.pointer) {
        if (!state.shown || level !== 'full') state.shown = { ...state.pointer };
        else {
          const follow = 1 - Math.exp(-dt / FOLLOW_TAU_MS);
          state.shown = {
            x: state.shown.x + (state.pointer.x - state.shown.x) * follow,
            y: state.shown.y + (state.pointer.y - state.shown.y) * follow,
          };
        }
      }
      const { width, height, ratio } = size;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      canvas.style.opacity = String(state.opacity);
      const ripple = state.ripple && level === 'full' ? Math.min(1, (now - state.ripple.at) / RIPPLE_MS) : null;
      const farthest = Math.hypot(width, height);
      ctx.fillStyle = ink;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      for (let top = 0; top < height; top += CELL_PX) {
        for (let left = 0; left < width; left += CELL_PX) {
          const cx = left + CELL_PX / 2;
          const cy = top + CELL_PX / 2;
          let glow = state.shown ? dropFieldGlow(Math.hypot(cx - state.shown.x, cy - state.shown.y), GLOW_RADIUS_PX) : 0;
          if (ripple !== null && state.ripple) {
            // A ring of light travelling out from the drop point.
            const front = ripple * farthest;
            const band = Math.abs(Math.hypot(cx - state.ripple.x, cy - state.ripple.y) - front);
            glow = Math.max(glow * (1 - ripple), dropFieldGlow(band, 90) * (1 - ripple));
          }
          ctx.globalAlpha = 0.025 + 0.13 * glow;
          ctx.fillRect(left + 1.5, top + 1.5, CELL_PX - 3, CELL_PX - 3);
          ctx.globalAlpha = 0.05 + 0.22 * glow;
          ctx.strokeRect(left + 1.5, top + 1.5, CELL_PX - 3, CELL_PX - 3);
        }
      }
      ctx.globalAlpha = 1;
      const settled = !state.visible && state.opacity === 0 && (ripple === null || ripple >= 1);
      if (settled) {
        state.ripple = null;
        state.shown = null;
        state.pointer = null;
        canvas.remove();
        handle = null;
        last = 0;
        return;
      }
      handle = requestFrame(draw);
    };
    const run = (): void => {
      if (handle) return;
      if (!ensureCanvas()) return;
      handle = requestFrame(draw);
    };

    const local = (event: DragEvent) => {
      const bounds = region.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const hide = (): void => {
      depth = 0;
      state.visible = false;
      if (handle || canvas?.isConnected) run();
    };

    const onDragEnter = (event: DragEvent) => {
      if (optionsRef.current.disabled || !carriesSystemFiles(event)) return;
      depth += 1;
      state.visible = true;
      state.pointer = local(event);
      run();
    };
    const onDragOver = (event: DragEvent) => {
      if (optionsRef.current.disabled || !carriesSystemFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (!state.visible) {
        state.visible = true;
        run();
      }
      state.pointer = local(event);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!state.visible) return;
      depth = Math.max(0, depth - 1);
      const into = event.relatedTarget;
      if (depth === 0 || !(into instanceof Node) || !region.contains(into)) hide();
    };
    const onDrop = (event: DragEvent) => {
      if (!state.visible) return;
      const point = local(event);
      // The composer frame takes the drops that land on it itself.
      const onFrame = event.target instanceof Node && frame.contains(event.target);
      if (!onFrame && !optionsRef.current.disabled) {
        const files = collectDroppedFiles(event.dataTransfer);
        if (files.length) {
          event.preventDefault();
          optionsRef.current.onFiles(files);
        }
      }
      state.ripple = { ...point, at: performance.now() };
      state.pointer = point;
      hide();
    };
    const onWindowDragEnd = () => { if (state.visible) hide(); };

    region.addEventListener('dragenter', onDragEnter);
    region.addEventListener('dragover', onDragOver);
    region.addEventListener('dragleave', onDragLeave);
    region.addEventListener('drop', onDrop);
    doc.defaultView?.addEventListener('dragend', onWindowDragEnd);
    doc.defaultView?.addEventListener('drop', onWindowDragEnd);
    return () => {
      region.removeEventListener('dragenter', onDragEnter);
      region.removeEventListener('dragover', onDragOver);
      region.removeEventListener('dragleave', onDragLeave);
      region.removeEventListener('drop', onDrop);
      doc.defaultView?.removeEventListener('dragend', onWindowDragEnd);
      doc.defaultView?.removeEventListener('drop', onWindowDragEnd);
      handle?.cancel();
      canvas?.remove();
    };
  }, [anchor]);
}
