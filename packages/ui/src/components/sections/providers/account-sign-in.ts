import type { ChannelTypeInfo } from '@varin/application-client';

/** UI availability while other account integrations are under review, not an authentication policy.
 * Existing credentials and backend providers keep their original ownership and behavior. */
export const accountSignInProviders = (type: ChannelTypeInfo) =>
  type.oauthProviders?.filter(provider => provider.id === 'openrouter') ?? [];
