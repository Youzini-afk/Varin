import type { DraftStarterRef } from '@/lib/draftStarters';

export interface VarinProjectRef {
  versionedWorkspace?: import('@varin/application-client').ProjectEntry['versionedWorkspace'];
  source?: import('@varin/application-client').ProjectEntry['source'];
  resourceOwner?: import('@varin/protocol').SourceResourceOwner;
  id: string;
  path: string;
}

export type VarinProjectActionPlatform = 'macos' | 'linux' | 'windows';

export interface VarinProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  platforms?: VarinProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
}

export interface VarinProjectActionsState {
  actions: VarinProjectAction[];
  primaryActionId: string | null;
}

export interface VarinProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface VarinProjectPlanFileLink {
  id: string;
  path: string;
  createdAt: number;
}

export interface VarinProjectPlanFile {
  title: string;
  body: string;
  raw: string;
  path: string;
}

export interface VarinProjectNotesTodos {
  notes: string;
  todos: VarinProjectTodoItem[];
}

export interface VarinProjectContextData extends VarinProjectNotesTodos {
  plans: VarinProjectPlanFileLink[];
}

export interface VarinProjectConfig extends Record<string, unknown> {
  projectPath?: string;
  setupWorktree?: string[];
  waitForWorktreeSetup?: boolean;
  projectNotes?: string;
  projectTodos?: VarinProjectTodoItem[];
  projectPlanFiles?: VarinProjectPlanFileLink[];
  projectActions?: VarinProjectAction[];
  projectActionsPrimaryId?: string;
  draftStarters?: DraftStarterRef[];
}
