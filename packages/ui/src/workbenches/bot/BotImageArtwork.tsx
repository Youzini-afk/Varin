import React from 'react';
import type { BotAppearanceAsset, BotAppearanceState, BotImageCrop } from '@varin/application-client';
import { defaultBotImageCrop } from '@varin/application-client';
import { RiImageLine } from '@remixicon/react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { acquireBotImage } from './botAppearanceResources';

export function BotImageArtwork({ asset, state = 'idle', compact = false, still = false, crop = defaultBotImageCrop() }: {
  asset: BotAppearanceAsset; state?: BotAppearanceState; compact?: boolean; still?: boolean; crop?: BotImageCrop;
}) {
  const host = React.useRef<HTMLSpanElement>(null);
  const [animate, setAnimate] = React.useState(false);
  const [shown, setShown] = React.useState<{ url: string; key: string } | null>(null);
  const shownResource = React.useRef<ReturnType<typeof acquireBotImage> | null>(null);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let visible = true;
    const refresh = () => setAnimate(visible && !document.hidden && !still && !compact && documentMotionLevel() === 'full');
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; refresh(); }) : null;
    if (host.current) observer?.observe(host.current);
    const motion = new MutationObserver(refresh); motion.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    document.addEventListener('visibilitychange', refresh); refresh();
    return () => { observer?.disconnect(); motion.disconnect(); document.removeEventListener('visibilitychange', refresh); };
  }, [compact, still]);
  const media = compact ? asset.portrait : asset.states[state] ?? (state.startsWith('tool-') ? asset.states.working : state === 'replying' ? asset.states.working : undefined) ?? asset.image;
  const hash = animate && media.animated ? media.hash : media.poster;
  React.useEffect(() => {
    let active = true;
    const resource = acquireBotImage(asset.id, hash);
    void resource.promise.then(url => {
      if (!active) return;
      const previous = shownResource.current; shownResource.current = resource;
      setShown({ url, key: `${asset.id}/${hash}` }); setError(false);
      // React commits the new image before releasing the previous object's URL.
      queueMicrotask(() => previous?.release());
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; if (shownResource.current !== resource) resource.release(); };
  }, [asset.id, hash]);
  React.useEffect(() => () => { shownResource.current?.release(); shownResource.current = null; }, []);
  return <span ref={host} className="bot-image-artwork" data-portrait={compact || !asset.transparent || undefined} data-error={error || undefined}>
    {shown ? <img key={shown.key} src={shown.url} alt="" draggable={false} style={{ objectFit: compact ? 'cover' : 'contain', objectPosition: `${crop.x * 100}% ${crop.y * 100}%`, transformOrigin: `${crop.x * 100}% ${crop.y * 100}%`, transform: `scale(${crop.scale})` }} />
      : <RiImageLine className="size-1/2 text-muted-foreground/40" />}
  </span>;
}
