import type { ThreadIdentity, ThreadThinkingLevel } from '@varin/application-client';

export interface MultiRunModelSelection {
  providerID: string;
  modelID: string;
  displayName?: string;
  variant?: ThreadThinkingLevel;
}
export interface MultiRunFileAttachment { mime: string; filename: string; url: string }
export interface MultiRunGroup { prompt: string; models: MultiRunModelSelection[] }
export interface CreateMultiRunParams {
  name: string;
  groups: MultiRunGroup[];
  worktreeBaseBranch?: string;
  isolateRuns?: boolean;
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
}
export interface CreateMultiRunResult {
  failures: Array<{ message: string; modelID: string; providerID: string; stage: 'create' | 'start' }>;
  groupSlug: string;
  identities: ThreadIdentity[];
  firstIdentity: ThreadIdentity | null;
}
