import React from 'react';
import type { ResourceFileLocation, ThreadIdentity, ThreadSourceTargets } from '@varin/application-client';
import type { SourceResourceOwner, ComputerDesktop } from '@varin/protocol';
import type { ComputerCatalog } from '@/lib/computers';

export type BotWorkspaceView =
  | { kind: 'external'; key: string; id: string; title: string }
  | { kind: 'work'; key: string; identity: ThreadIdentity; title: string; operationId?: string }
  | { kind: 'computer'; key: string; desktop: ComputerDesktop; title: string }
  | { kind: 'files'; key: string; owner: SourceResourceOwner; title: string; task?: ThreadIdentity; path?: string };
export interface BotWorkspaceNavigation {
  views: BotWorkspaceView[];
  activeKey: string | null;
  focusRevision: number;
  sources: ThreadSourceTargets | null;
  computers: ComputerCatalog | null;
  error: string | null;
  refresh(): void;
  open(view: BotWorkspaceView): void;
  select(key: string | null): void;
  close(key: string): void;
  files(owner: SourceResourceOwner, title: string, task?: ThreadIdentity, path?: string): void;
  computer(desktop: ComputerDesktop): void;
  connections(): void;
  cite(location: ResourceFileLocation, path: string, target?: ThreadIdentity): Promise<void>;
}
export const BotWorkspaceNavigationContext = React.createContext<BotWorkspaceNavigation | null>(null);
export const useBotWorkspaceNavigation = () => React.useContext(BotWorkspaceNavigationContext);
