import { useEffect, useMemo, useState } from 'react';
import type { CompanionPackage } from './sequencePackage';
import { CompanionPlayback, frameAt, type PlaybackAsset } from './playback.mjs';

/** Only accepted art may follow real Host intent; file-review candidates are not promoted. */
export function useCompanionPlayback(packages: CompanionPackage[], requestedAction: string | null, paused = false) {
  const accepted = useMemo(() => packages.filter((asset): asset is PlaybackAsset =>
    asset.reviewStatus === 'accepted' && asset.stage === 'motion-candidate'
    && !!asset.entryPose && !!asset.exitPose && !!asset.geometryReference), [packages]);
  const controller = useMemo(() => new CompanionPlayback(accepted), [accepted]);
  const [view, setView] = useState<{ packageId: string | null; exposure: number; blocker: string | null }>({ packageId: null, exposure: 0, blocker: null });
  useEffect(() => {
    if (!accepted.length) {
      setView({ packageId: null, exposure: 0, blocker: 'No visually accepted artwork installed for automatic playback' });
      return;
    }
    const target = accepted.find(asset => asset.action === requestedAction);
    controller.request(target?.id ?? 'missing-current-intent', { urgent: requestedAction === null });
    let request = 0, previous: number | undefined;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = (now: number) => {
      // Hidden time is not animation time: return to the displayed contact pose.
      if (!paused && !document.hidden && !reduced.matches && previous !== undefined) controller.tick(Math.min(now - previous, 100));
      previous = now;
      const current = controller.current;
      const exposure = current ? current.frames.indexOf(frameAt(current, controller.timeMs)!) : 0;
      setView(old => old.packageId === (current?.id ?? null) && old.exposure === exposure && old.blocker === controller.blocker
        ? old : { packageId: current?.id ?? null, exposure, blocker: controller.blocker });
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, [accepted, controller, requestedAction, paused]);
  return view;
}
