import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n/store';

export interface WorkbenchCommandExecutionContext {
  currentDirectory: string | null;
  isMobile: boolean;
}

export interface WorkbenchCommandImplementation {
  execute(context: WorkbenchCommandExecutionContext): void | Promise<void>;
  isAvailable?: (context: WorkbenchCommandExecutionContext) => boolean;
}

export interface WorkbenchCommandMeta {
  commandId: string;
  icon: IconName;
  keywords: string[];
  mobileTitleKey?: I18nKey;
  order: number;
  shortcutId?: string;
  title?: string;
  titleKey?: I18nKey;
}

export interface WorkbenchCommandRegistration {
  contributionId: string;
  implementation: WorkbenchCommandImplementation;
  meta: WorkbenchCommandMeta;
}
