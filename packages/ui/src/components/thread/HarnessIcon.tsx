import type { ExternalHarness } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import openai from '@/assets/provider-logos/openai.svg';
import claude from '@/assets/provider-logos/claude.svg';

export function HarnessIcon({
  harness,
  profileId,
  className = 'size-4',
}: {
  harness?: ExternalHarness;
  profileId?: string;
  className?: string;
}) {
  if (harness === 'codex' || harness === 'claude')
    return (
      <img
        src={harness === 'codex' ? openai : claude}
        alt=""
        draggable={false}
        className={`${className} shrink-0 object-contain dark:invert`}
      />
    );
  if (profileId && ['opencode', 'gemini', 'kimi', 'cursor', 'qoder', 'grok'].includes(profileId)) return <span aria-hidden className={`${className} inline-flex shrink-0 items-center justify-center rounded font-mono font-semibold leading-none`}>{profileId === 'opencode' ? 'O' : profileId.slice(0, 1).toUpperCase()}</span>;
  if (harness === 'pi')
    return (
      <span
        aria-hidden
        className={`${className} inline-flex shrink-0 items-center justify-center font-mono font-semibold leading-none`}
      >
        π
      </span>
    );
  return <Icon name="terminal" className={`${className} shrink-0`} />;
}
