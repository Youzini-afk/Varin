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

import qoder from '@/assets/harness-logos/qoder.svg';
import qoderDark from '@/assets/harness-logos/qoder-dark.svg';
import grok from '@/assets/harness-logos/grok.svg';
import grokDark from '@/assets/harness-logos/grok-dark.svg';
import dsh from '@/assets/harness-logos/deepseek-harness.svg';
import cline from '@/assets/harness-logos/cline.svg';
import clineDark from '@/assets/harness-logos/cline-dark.svg';
import codebuddy from '@/assets/harness-logos/codebuddy.svg';
import codebuddyDark from '@/assets/harness-logos/codebuddy-dark.svg';
import openclaw from '@/assets/harness-logos/openclaw.svg';
import hermes from '@/assets/harness-logos/hermes-agent.svg';
import hermesDark from '@/assets/harness-logos/hermes-agent-dark.svg';
import antigravity from '@/assets/harness-logos/google-antigravity.svg';
import antigravityDark from '@/assets/harness-logos/google-antigravity-dark.svg';
import kiro from '@/assets/harness-logos/kiro.svg';
import zcode from '@/assets/harness-logos/zcode.svg';
import trae from '@/assets/harness-logos/trae.svg';
import command_code from '@/assets/harness-logos/command-code.svg';
import minimax from '@/assets/harness-logos/minimax-code.svg';

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
  'qoder': { src: qoder, darkSrc: qoderDark },
  'grok': { src: grok, darkSrc: grokDark },
  'dsh': { src: dsh },
  'cline': { src: cline, darkSrc: clineDark },
  'codebuddy': { src: codebuddy, darkSrc: codebuddyDark },
  'openclaw': { src: openclaw },
  'hermes': { src: hermes, darkSrc: hermesDark },
  'antigravity': { src: antigravity, darkSrc: antigravityDark },
  'kiro': { src: kiro },
  'zcode': { src: zcode },
  'trae': { src: trae },
  'command-code': { src: command_code },
  'minimax': { src: minimax },
  'deepseek-acp': { src: dsh },
};
const acpProducts = new Set(Object.keys(products).filter(id => !['codex', 'claude', 'pi'].includes(id)));

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
