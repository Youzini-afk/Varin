import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompanionPackage } from './sequencePackage';
import { CompanionPlayback, frameAt, route, type PlaybackAsset } from './playback.mjs';

/** Only accepted art may follow real Host intent; file-review candidates are not promoted. */
export function useCompanionPlayback(packages: CompanionPackage[], requestedAction: string | null, paused = false, readyIds: string[] = []) {
  const accepted = useMemo(() => packages.filter((asset): asset is PlaybackAsset =>
    asset.reviewStatus === 'accepted' && asset.stage === 'motion-candidate'
    && !!asset.entryPose && !!asset.exitPose && !!asset.geometryReference), [packages]);
  const ready = useRef(new Set(readyIds)); ready.current = new Set(readyIds);
  const controller = useMemo(() => new CompanionPlayback(accepted), [accepted]);
  controller.canDisplay = id => ready.current.has(id);
  const [view, setView] = useState<{ packageId: string | null; exposure: number; blocker: string | null; finished: boolean; neededPackageId: string | null }>({ packageId: null, exposure: 0, blocker: null, finished: false, neededPackageId: null });
  useEffect(() => {
    if (!accepted.length) {
      setView({ packageId: null, exposure: 0, blocker: 'No visually accepted artwork installed for automatic playback', finished: false, neededPackageId: null });
      return;
    }
    const candidates = accepted.filter(asset => asset.action === requestedAction);
    const target = candidates.map(asset => ({ asset, path: route(controller.current, asset, accepted) }))
      .filter(item => item.path.status === 'ready').sort((a,b) => a.path.clips.length-b.path.clips.length)[0]?.asset ?? candidates[0];
    controller.request(target?.id ?? 'missing-current-intent', { urgent: requestedAction === null });
    let request = 0, previous: number | undefined;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = (now: number) => {
      if (controller.loading && ready.current.has(controller.loading)) { controller.advance(); previous = undefined; }
      // Hidden time is not animation time: return to the displayed contact pose.
      if (paused || document.hidden || reduced.matches) previous = undefined;
      else { if (previous !== undefined) controller.tick(now - previous); previous = now; }
      const current = controller.current;
      const exposure = current ? current.frames.indexOf(frameAt(current, controller.timeMs)!) : 0;
      const neededPackageId = controller.loading ?? controller.path[0] ?? null;
      const finished = !!current && !current.loop && controller.timeMs >= current.durationMs;
      setView(old => old.neededPackageId === neededPackageId && old.finished === finished && old.packageId === (current?.id ?? null) && old.exposure === exposure && old.blocker === controller.blocker
        ? old : { packageId: current?.id ?? null, exposure, blocker: controller.blocker, finished, neededPackageId });
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, [accepted, controller, requestedAction, paused]);
  return view;
}
