import type { ComputerFrame, ComputerHumanInput } from '@varin/protocol';

export function desktopPoint(bounds: ComputerFrame, rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) {
  if (rect.width <= 0 || rect.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: bounds.x + Math.min(bounds.width - 1, Math.max(0, Math.floor((clientX - rect.left) * bounds.width / rect.width))),
    y: bounds.y + Math.min(bounds.height - 1, Math.max(0, Math.floor((clientY - rect.top) * bounds.height / rect.height))),
  };
}

export function desktopKey(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing?: boolean }): ComputerHumanInput | null {
  if (event.isComposing || ['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null;
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) return { kind: 'text', text: event.key };
  const names: Record<string, string> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'page_up', PageDown: 'page_down', ' ': 'space', Escape: 'esc' };
  const modifiers = [event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift', event.metaKey && 'cmd'].filter(Boolean);
  return { kind: 'key', key: [...modifiers, names[event.key] ?? event.key.toLowerCase()].join('+') };
}
