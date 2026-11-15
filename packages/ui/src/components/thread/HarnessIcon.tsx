import type { ExternalHarness } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import codex from '@/assets/harness-logos/codex.svg';
import claude from '@/assets/provider-logos/claude.svg';
import pi from '@/assets/harness-logos/pi.svg';
import opencode from '@/assets/harness-logos/opencode.svg';
import gemini from '@/assets/harness-logos/gemini.png';
import kimi from '@/assets/harness-logos/kimi.png';
import cursor from '@/assets/harness-logos/cursor.svg';
import cursorDark from '@/assets/harness-logos/cursor-dark.svg';

// Product identity comes from the execution binding, never its task/configuration display name.
// ACP is a protocol: only a known profile/configuration may select a product mark.
// Asset provenance, theme treatment and intentionally neutral fallbacks live beside the assets.
const products: Record<string, { src: string; darkSrc?: string; theme?: string }> = {
  codex: { src: codex, theme: 'dark:invert' },
  claude: { src: claude, theme: 'dark:invert' },
  pi: { src: pi, theme: 'invert dark:invert-0' },
  opencode: { src: opencode, theme: 'dark:invert' },
  gemini: { src: gemini },
  kimi: { src: kimi },
  cursor: { src: cursor, darkSrc: cursorDark },
};
const acpProducts = new Set(['opencode', 'gemini', 'kimi', 'cursor', 'qoder', 'grok']);

export function HarnessIcon({
  harness,
  configurationId,
  profileId,
  className = 'size-4',
}: {
  harness?: ExternalHarness;
  configurationId?: string;
  profileId?: string;
  className?: string;
}) {
  const profile = profileId ?? configurationId;
  const product = harness === 'acp'
    ? profile && acpProducts.has(profile) ? profile : undefined
    : harness;
  const asset = product ? products[product] : undefined;
  if (!asset) return <Icon name="terminal" className={`${className} shrink-0`} />;
  const style = `${className} shrink-0 object-contain`;
  return <>
    <img src={asset.src} alt="" draggable={false} className={`${style} ${asset.darkSrc ? 'dark:hidden' : asset.theme ?? ''}`} />
    {asset.darkSrc && <img src={asset.darkSrc} alt="" draggable={false} className={`${style} hidden dark:block`} />}
  </>;
}
