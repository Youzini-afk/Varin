/** Bot-owned presentation; independent of its model, instructions and execution. */
export interface BotImageCrop { x: number; y: number; scale: number }
export type BotAppearance =
  | { kind: 'varin'; color: 'theme' | 'original' | string }
  | { kind: 'custom'; assetId: string; portrait: BotImageCrop; figure: BotImageCrop };
export const BOT_APPEARANCE_STATES = ['idle', 'listening', 'thinking', 'working', 'waiting', 'sleeping', 'waking', 'offline', 'preparing', 'replying', 'supervising', 'tool-read', 'tool-search', 'tool-web', 'tool-edit', 'tool-shell', 'tool-memory', 'tool-plan', 'tool-other'] as const;
export type BotAppearanceState = typeof BOT_APPEARANCE_STATES[number];
export interface BotAppearanceMedia { hash: string; mime: string; width: number; height: number; animated: boolean; poster: string }
export interface BotAppearanceAsset {
  id: string;
  name: string;
  transparent: boolean;
  image: BotAppearanceMedia;
  portrait: BotAppearanceMedia;
  states: Partial<Record<BotAppearanceState, BotAppearanceMedia>>;
}
export interface BotAppearancesAPI {
  list(signal?: AbortSignal): Promise<BotAppearanceAsset[]>;
  get(id: string, signal?: AbortSignal): Promise<BotAppearanceAsset>;
  import(file: File, signal?: AbortSignal): Promise<BotAppearanceAsset>;
  remove(id: string): Promise<void>;
  media(id: string, hash: string, signal?: AbortSignal): Promise<Blob>;
}
export const defaultBotAppearance = (): BotAppearance => ({ kind: 'varin', color: 'theme' });
export const defaultBotImageCrop = (): BotImageCrop => ({ x: .5, y: .5, scale: 1 });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bot appearance');
  return value as Record<string, unknown>;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid Bot appearance asset');
  return value;
};
export function parseBotImageCrop(value: unknown): BotImageCrop {
  const input = object(value);
  if (typeof input.x !== 'number' || !Number.isFinite(input.x) || input.x < 0 || input.x > 1
    || typeof input.y !== 'number' || !Number.isFinite(input.y) || input.y < 0 || input.y > 1
    || typeof input.scale !== 'number' || !Number.isFinite(input.scale) || input.scale <= 0) throw new Error('Invalid Bot image crop');
  return { x: input.x, y: input.y, scale: input.scale };
}
export function parseBotAppearance(value: unknown): BotAppearance {
  const input = object(value);
  if (input.kind === 'varin' && typeof input.color === 'string' && (['theme', 'original'].includes(input.color) || /^#[a-f0-9]{6}$/i.test(input.color)))
    return { kind: 'varin', color: input.color.toLowerCase() };
  if (input.kind === 'custom') return { kind: 'custom', assetId: hash(input.assetId), portrait: parseBotImageCrop(input.portrait), figure: parseBotImageCrop(input.figure) };
  throw new Error('Invalid Bot appearance');
}
export function parseBotAppearanceAsset(value: unknown): BotAppearanceAsset {
  const input = object(value), states = object(input.states);
  const media = (value: unknown): BotAppearanceMedia => {
    const item = object(value);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mime)) || typeof item.animated !== 'boolean'
      || !Number.isSafeInteger(item.width) || Number(item.width) <= 0 || !Number.isSafeInteger(item.height) || Number(item.height) <= 0) throw new Error('Invalid Bot image');
    return { hash: hash(item.hash), poster: hash(item.poster), mime: String(item.mime), width: Number(item.width), height: Number(item.height), animated: item.animated };
  };
  if (typeof input.name !== 'string' || !input.name.trim() || typeof input.transparent !== 'boolean') throw new Error('Invalid Bot appearance asset');
  const parsed: BotAppearanceAsset['states'] = {};
  for (const [state, value] of Object.entries(states)) {
    if (!BOT_APPEARANCE_STATES.includes(state as BotAppearanceState)) throw new Error(`Unknown Bot appearance state: ${state}`);
    parsed[state as BotAppearanceState] = media(value);
  }
  return { id: hash(input.id), name: input.name, transparent: input.transparent, image: media(input.image), portrait: media(input.portrait), states: parsed };
}
