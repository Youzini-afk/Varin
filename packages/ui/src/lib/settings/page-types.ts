import type React from 'react';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n/store';

export type SettingsPageSlug = string;

export type SettingsPageGroup = 'general' | 'projects' | 'harness' | 'pi';

export interface SettingsRuntimeContext {
  isWeb: boolean;
  isDesktop: boolean;
  isMobile: boolean;
  mcpInstalled: boolean;
}

export interface SettingsPageMeta {
  slug: SettingsPageSlug;
  title: string;
  titleKey: I18nKey;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  icon: IconName | 'mcp' | null;
  order: number;
  badgeKey?: I18nKey;
  keywords?: string[];
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

export interface SettingsPageImplementation {
  renderContent: () => React.ReactNode;
  renderSidebar?: (options: { onItemSelect?: () => void }) => React.ReactNode;
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

export interface SettingsPageRegistration {
  contributionId: string;
  implementation: SettingsPageImplementation;
  meta: SettingsPageMeta;
}
