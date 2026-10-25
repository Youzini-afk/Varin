import React from 'react';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';

const COUNT_MS = 600;
// The base out-curve (`EASE_OUT`) as a cubic for a manual tween.
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * A number that rolls to its value. With `animate`, a change counts from the
 * previous value (or from zero on first show) over 600ms; without it, and
 * under reduced or off motion, the value is shown directly. Screen readers get
 * the final value through the parent's label, not the rolling digits.
 */
export function CountUp({ value, animate, format }: { value: number; animate: boolean; format(value: number): string }) {
  const [shown, setShown] = React.useState(() => animate && documentMotionLevel() === 'full' ? 0 : value);
  const from = React.useRef(shown);
  const frame = React.useRef<FrameHandle | null>(null);
  const formatRef = React.useRef(format);
  formatRef.current = format;

  React.useEffect(() => {
    frame.current?.cancel();
    frame.current = null;
    if (!animate || documentMotionLevel() !== 'full' || from.current === value) {
      from.current = value;
      setShown(value);
      return undefined;
    }
    const start = from.current;
    let began: number | null = null;
    const tick = (time: number) => {
      began ??= time;
      const progress = Math.min(1, (time - began) / COUNT_MS);
      const next = start + (value - start) * easeOut(progress);
      from.current = next;
      setShown(next);
      frame.current = progress < 1 ? requestFrame(tick) : null;
    };
    frame.current = requestFrame(tick);
    return () => { frame.current?.cancel(); frame.current = null; };
  }, [value, animate]);

  const rounded = Number.isInteger(value) ? Math.round(shown) : shown;
  return <>{formatRef.current(rounded)}</>;
}
