import type React from 'react';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n/store';

export type ComposerCommandGroup = 'conversation' | 'execution' | 'context' | 'collaboration' | 'resources' | 'application' | 'management' | 'skills';
export interface ComposerCommandMeta { name: string; group: ComposerCommandGroup; interaction: 'action' | 'select'; }
export interface ComposerCommandDraftContext { text: string; selectedText: string; }
export interface ComposerCommandAction { run?(): void | Promise<void>; content?: React.ReactNode | ((complete: () => void, context?: ComposerCommandDraftContext) => React.ReactNode); disabled?: string; value?: string; }
export interface WorkbenchCommandExecutionContext {
  currentDirectory: string | null;
  isMobile: boolean;
  composer?: { host: number; identity?: ThreadIdentity; source?: ThreadSource; actions: Record<string, ComposerCommandAction | undefined> };
}

export interface WorkbenchCommandImplementation {
  execute(context: WorkbenchCommandExecutionContext): void | Promise<void>;
  isAvailable?: (context: WorkbenchCommandExecutionContext) => boolean;
}

export interface WorkbenchCommandMeta {
  commandId: string;
  composer?: ComposerCommandMeta;
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
