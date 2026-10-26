import type { ExternalHarness } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import openai from '@/assets/provider-logos/openai.svg';
import claude from '@/assets/provider-logos/claude.svg';

export function HarnessIcon({
  harness,
  className = 'size-4',
}: {
  harness?: ExternalHarness;
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
