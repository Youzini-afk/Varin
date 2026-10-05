import React from 'react';
import type { ThreadParent } from '@varin/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

export interface HarnessThreadStateValue {
  merge(snapshot: HarnessThreadSnapshot): void;
  parent: ThreadParent;
  reload(): Promise<void>;
  threads: HarnessThreadSnapshot[];
  researchRoot: HarnessThreadSnapshot | null;
  researchBranches: HarnessThreadSnapshot[];
  loadError: string | null;
  workspaceId: string;
}

const EMPTY_STATE: HarnessThreadStateValue = {
  merge: () => {},
  parent: { kind: 'session', id: '' },
  reload: async () => {},
  threads: [],
  researchRoot: null,
  researchBranches: [],
  loadError: null,
  workspaceId: '',
};

export const HarnessThreadStateContext = React.createContext<HarnessThreadStateValue>(EMPTY_STATE);

export const useHarnessThreadState = (): HarnessThreadStateValue => React.useContext(HarnessThreadStateContext);
