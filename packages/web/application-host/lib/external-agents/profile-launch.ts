import { ExternalAgentError, type ExternalAgentProfile } from '@varin/application-client';

export function assertProfilePlatform(profile: ExternalAgentProfile | undefined, platform: string, architecture: string) {
  if (!profile) return;
  if (!profile.platforms.includes(platform) || profile.platformArchitectures?.[platform] && !profile.platformArchitectures[platform]!.includes(architecture))
    throw new ExternalAgentError('platform_unsupported', `${profile.name} has no upstream-supported launch profile for ${platform}/${architecture}`);
}

export function profileVersionArguments(args: string[], profile?: ExternalAgentProfile): string[] {
  const suffix = profile?.launch.args ?? [];
  const matched = suffix.length > 0 && suffix.every((arg, index) => args[args.length - suffix.length + index] === arg);
  // Only remove the profile's known protocol mode. Preserve executable/shim prefixes
  // and user flags; an arbitrary custom launch is never rewritten by command guessing.
  return profile?.versionArgs && matched
    ? [...args.slice(0, -suffix.length), ...profile.versionArgs]
    : [...args, '--version'];
}
