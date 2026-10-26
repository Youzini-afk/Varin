/** Ephemeral launch geometry; never part of persisted UI settings or execution state. */
export type DialogMotionKey = 'settings' | 'help';
export type DialogRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
export interface DialogMotionOrigin { rect: DialogRect; element: WeakRef<HTMLElement> }
const origins = new Map<DialogMotionKey, DialogMotionOrigin>();

const visible = (rect: DialogRect) => rect.width > 0 && rect.height > 0;
const copyRect = ({ left, top, width, height }: DialogRect): DialogRect => ({ left, top, width, height });

export function captureDialogOrigin(key: DialogMotionKey, element?: HTMLElement): void {
  const rect = element?.getBoundingClientRect();
  if (!element || !rect || !visible(rect)) { origins.delete(key); return; }
  origins.set(key, { rect: copyRect(rect), element: new WeakRef(element) });
}

export const dialogOrigin = (key: DialogMotionKey) => origins.get(key);

export function currentDialogOrigin(origin: DialogMotionOrigin): DialogRect {
  const element = origin.element.deref();
  const rect = element?.isConnected ? element.getBoundingClientRect() : undefined;
  return rect && visible(rect) ? rect : origin.rect;
}

/** Uniform scaling keeps page contents undistorted throughout the flight. */
export function dialogFlightGeometry(popup: DialogRect, source: DialogRect) {
  if (!visible(popup) || !visible(source)) return null;
  return {
    x: source.left + source.width / 2 - popup.left - popup.width / 2,
    y: source.top + source.height / 2 - popup.top - popup.height / 2,
    scale: Math.min(1, source.width / popup.width, source.height / popup.height),
  };
}
