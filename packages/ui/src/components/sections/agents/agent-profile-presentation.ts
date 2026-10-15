import type { AgentProfileView } from '@varin/application-client';
import type { I18nKey } from '@/lib/i18n';

export function agentProfileLabels(profile: AgentProfileView, t: (key: I18nKey) => string) {
  if (profile.config.kind === 'custom') return { name: profile.effective.name, description: profile.effective.description };
  const { slot, binding } = profile.config;
  return {
    name: binding.agent?.name ?? t(`settings.harness.role.${slot}`),
    description: binding.agent?.description ?? t(`settings.harness.role.${slot}.description`),
  };
}
export function agentProfileDefaultLabels(profile: AgentProfileView | undefined, t: (key: I18nKey) => string) {
  return profile?.config.kind === 'builtin' ? {
    name: t(`settings.harness.role.${profile.config.slot}`),
    description: t(`settings.harness.role.${profile.config.slot}.description`),
  } : undefined;
}
