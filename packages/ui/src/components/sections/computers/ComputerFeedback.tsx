import React from 'react';
import type { ComputerFrame, ComputerGesture } from '@varin/protocol';
import { COMPUTER_FEEDBACK_HTML } from '@/lib/computerFeedback';
import { useI18n } from '@/lib/i18n';

export interface ComputerFeedbackHandle { show(gesture: ComputerGesture): void; clear(): void; setEnabled(enabled: boolean): void }
export const ComputerFeedback = React.forwardRef<ComputerFeedbackHandle, { bounds?: ComputerFrame; disabled: boolean; upscale: boolean }>(function ComputerFeedback({ bounds, disabled, upscale }, handle) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const { t } = useI18n();
  const [ready, setReady] = React.useState(false);
  const latest = React.useRef({ ready, bounds, disabled }); latest.current = { ready, bounds, disabled };
  const pending = React.useRef<ComputerGesture[]>([]);
  const clear = React.useCallback(() => { pending.current = []; ref.current?.contentWindow?.postMessage({ type: 'clear' }, '*'); }, []);
  React.useImperativeHandle(handle, () => ({ clear, setEnabled(enabled) { latest.current.disabled = !enabled; if (!enabled) clear(); }, show(gesture) {
    if (latest.current.disabled) return;
    if (latest.current.ready && latest.current.bounds) ref.current?.contentWindow?.postMessage({ type: 'gesture', gesture }, '*');
    else { if (pending.current[0]?.id !== gesture.id) pending.current = []; pending.current.push(gesture); }
  } }), [clear]);
  const configuration = React.useMemo(() => ({ type: 'configure', bounds, upscale, labels: {
    type: t('computer.feedback.type'), set_value: t('computer.feedback.value'), scroll: t('computer.feedback.scroll'),
  } }), [bounds, t, upscale]);
  React.useEffect(() => {
    if (disabled) { clear(); return; }
    if (ready && bounds) {
      ref.current?.contentWindow?.postMessage(configuration, '*');
      for (const gesture of pending.current.splice(0)) if (Date.now() - Date.parse(gesture.at) < 1800) ref.current?.contentWindow?.postMessage({ type: 'gesture', gesture }, '*');
    }
  }, [ready, bounds, configuration, disabled, clear]);
  return <iframe ref={ref} srcDoc={COMPUTER_FEEDBACK_HTML} sandbox="allow-scripts" tabIndex={-1} title={t('computer.feedback.title')}
    aria-hidden="true" onLoad={() => setReady(true)} className="pointer-events-none absolute inset-0 h-full w-full border-0" />;
});
