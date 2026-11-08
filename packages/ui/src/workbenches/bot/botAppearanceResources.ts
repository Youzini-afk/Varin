import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange, type BotAppearanceAsset, type BotAppearance } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export const botAppearanceAPI = () => {
  const api = getRegisteredRuntimeAPIs()?.bots?.appearances;
  if (!api) throw new Error('Bot appearance service is unavailable');
  return api;
};
const assets = new Map<string, Promise<BotAppearanceAsset>>();
const profiles = new Map<string, Promise<BotAppearance | undefined>>();
interface ImageResource { refs: number; controller: AbortController; promise: Promise<string>; url?: string }
const images = new Map<string, ImageResource>();
subscribeRuntimeEndpointWillChange(() => {
  assets.clear(); profiles.clear();
  for (const item of images.values()) { item.controller.abort(); if (item.url) URL.revokeObjectURL(item.url); }
  images.clear();
});
subscribeVarinEvents(event => { if (event.type === 'bot-changed') profiles.delete(event.botId); if (event.type === 'stream-ready') { profiles.clear(); assets.clear(); } });

export function useBotFigureAppearance(botId?: string) {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [value, setValue] = React.useState<{ id: string; host: number; appearance?: BotAppearance } | null>(null);
  React.useEffect(() => {
    if (!botId) return;
    let active = true;
    const host = getRuntimeEndpointGeneration();
    const load = () => {
      let pending = profiles.get(botId);
      if (!pending) {
        const api = getRegisteredRuntimeAPIs()?.bots; if (!api) return;
        pending = api.get(botId).then(bot => bot?.appearance); profiles.set(botId, pending);
        const requested = pending;
        void pending.catch(() => { if (profiles.get(botId) === requested) profiles.delete(botId); });
      }
      void pending.then(appearance => { if (active && host === getRuntimeEndpointGeneration()) setValue({ id: botId, host, ...(appearance ? { appearance } : {}) }); }).catch(() => undefined);
    };
    load();
    const stop = subscribeVarinEvents(event => { if (event.type === 'stream-ready' || event.type === 'bot-changed' && event.botId === botId) load(); });
    return () => { active = false; stop(); };
  }, [botId, generation]);
  return value?.id === botId && value?.host === generation ? value.appearance : undefined;
}

export function useBotAppearanceAsset(id: string, supplied?: BotAppearanceAsset): { asset?: BotAppearanceAsset; error?: string } {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [state, setState] = React.useState<{ id: string; host: number; asset?: BotAppearanceAsset; error?: string } | null>(null);
  React.useEffect(() => {
    if (!id || supplied?.id === id) return;
    let active = true; const host = getRuntimeEndpointGeneration();
    let pending = assets.get(id);
    if (!pending) { pending = Promise.resolve().then(() => botAppearanceAPI().get(id)); assets.set(id, pending); const requested = pending; void pending.catch(() => { if (assets.get(id) === requested) assets.delete(id); }); }
    void pending.then(asset => { if (active && host === getRuntimeEndpointGeneration()) setState({ id, host, asset }); })
      .catch(error => { if (active) setState({ id, host, error: String(error) }); });
    return () => { active = false; };
  }, [id, supplied, generation]);
  return supplied?.id === id ? { asset: supplied } : state?.id === id && state.host === generation ? state : {};
}

export function acquireBotImage(id: string, hash: string) {
  const key = `${id}/${hash}`;
  let resource = images.get(key);
  if (!resource) {
    const controller = new AbortController();
    const next: ImageResource = { refs: 0, controller, promise: Promise.resolve('') };
    next.promise = botAppearanceAPI().media(id, hash, controller.signal).then(async blob => {
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob); next.url = url;
      const image = new Image(); image.src = url;
      try { await image.decode(); controller.signal.throwIfAborted(); return url; }
      catch (error) { URL.revokeObjectURL(url); delete next.url; throw error; }
    });
    resource = next; images.set(key, next);
    void next.promise.catch(() => { if (images.get(key) === next) images.delete(key); });
  }
  const held = resource; held.refs++;
  return { promise: held.promise, release() {
    held.refs--;
    queueMicrotask(() => {
      if (held.refs || images.get(key) !== held) return;
      images.delete(key); held.controller.abort(); if (held.url) URL.revokeObjectURL(held.url);
    });
  } };
}
