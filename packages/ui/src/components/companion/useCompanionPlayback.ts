import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompanionPackage } from './sequencePackage';
import { CompanionPlayback, frameAt, route, type PlaybackAsset } from './playback.mjs';

/** Only accepted art may follow real Host intent; file-review candidates are not promoted. */
export function useCompanionPlayback(packages: CompanionPackage[], requestedAction: string | null, paused = false, readyIds: string[] = [], interaction?: { phase: 'rest' | 'lifting' | 'landing'; displayed: () => { packageId: string; exposure: number } | null }) {
  const accepted = useMemo(() => packages.filter((asset): asset is PlaybackAsset =>
    asset.reviewStatus === 'accepted' && asset.stage === 'motion-candidate'
    && !!asset.entryPose && !!asset.exitPose && !!asset.geometryReference), [packages]);
  const ready = useRef(new Set(readyIds)); ready.current = new Set(readyIds);
  const controller = useMemo(() => new CompanionPlayback(accepted), [accepted]);
  const entries = useMemo(() => new Map(accepted.filter(asset => asset.gesture?.entrySourceSha256).map(asset => [asset.gesture!.entrySourceSha256!, asset])), [accepted]);
  controller.canDisplay = id => {
    if (!ready.current.has(id)) return false;
    const asset = accepted.find(item => item.id === id);
    return !!asset && (asset.gesture !== undefined || asset.frames.every(frame => {
      const entry = frame.sha256 && entries.get(frame.sha256);
      return !entry || [entry.id, ...entry.gesture!.grabNext.slice(0,2)].every(next => ready.current.has(next));
    }));
  };
  const preparedGrab = useRef(false);
  const beginGrab = (displayed: { packageId: string; exposure: number } | null) => {
    preparedGrab.current = true;
    if (!controller.grab(displayed ?? undefined)) return null;
    const drawing = controller.current ? { packageId: controller.current.id, exposure: controller.current.frames.indexOf(frameAt(controller.current, controller.timeMs)!) } : null;
    if (drawing) setView(old => ({ ...old, ...drawing, finished: false, gestureActive: !!controller.gesture, worldEvent: controller.worldEvent, neededPackageId: controller.loading ?? controller.path[0] ?? null, blocker: controller.blocker }));
    return drawing;
  };
  const interactionRef = useRef(interaction); interactionRef.current = interaction;
  useEffect(() => {
    const input = interactionRef.current;
    if (input?.phase === 'lifting') { if (!preparedGrab.current) controller.grab(input.displayed() ?? undefined); preparedGrab.current = false; }
    else if (input?.phase === 'landing') controller.release(input.displayed() ?? undefined);
  }, [controller, interaction?.phase]);
  const [view, setView] = useState<{ packageId: string | null; exposure: number; blocker: string | null; finished: boolean; neededPackageId: string | null; gestureActive: boolean; worldEvent: CompanionPlayback['worldEvent'] }>({ packageId: null, exposure: 0, blocker: null, finished: false, neededPackageId: null, gestureActive: false, worldEvent: null });
  useEffect(() => {
    if (!accepted.length) {
      setView({ packageId: null, exposure: 0, blocker: 'No visually accepted artwork installed for automatic playback', finished: false, neededPackageId: null, gestureActive: false, worldEvent: null });
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
      // Reduced motion suppresses repeated performance at the authored loop's
      // next explicitly safe drawing, not necessary state changes or pointer release/landing.
      const reducedHold = reduced.matches && controller.canPauseRepeatedMotion();
      // Hidden time is not animation time: return to the displayed contact pose.
      if (paused || document.hidden || reducedHold) previous = undefined;
      else { if (previous !== undefined) controller.tick(now - previous); previous = now; }
      const current = controller.current;
      const exposure = current ? current.frames.indexOf(frameAt(current, controller.timeMs)!) : 0;
      const gestureActive = !!controller.gesture, worldEvent = controller.worldEvent;
      const neededPackageId = controller.loading ?? controller.path[0] ?? null;
      const finished = !!current && !current.loop && controller.timeMs >= current.durationMs;
      setView(old => old.gestureActive === gestureActive && old.worldEvent?.revision === worldEvent?.revision && old.neededPackageId === neededPackageId && old.finished === finished && old.packageId === (current?.id ?? null) && old.exposure === exposure && old.blocker === controller.blocker
        ? old : { packageId: current?.id ?? null, exposure, blocker: controller.blocker, finished, neededPackageId, gestureActive, worldEvent });
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, [accepted, controller, requestedAction, paused]);
  return { ...view, beginGrab };
}
