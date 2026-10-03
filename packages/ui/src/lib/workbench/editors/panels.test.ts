import { afterEach, describe, expect, test } from 'vitest';
import {
  getWorkbenchOutput,
  getWorkbenchProblems,
  peekWorkbenchPanelLayout,
  resetWorkbenchPanelsForRuntimeSwitch,
  setWorkbenchOutput,
  setWorkbenchProblems,
  showWorkbenchPanel,
} from './panels';

afterEach(() => {
  resetWorkbenchPanelsForRuntimeSwitch();
});

describe('workbench panels', () => {
  test('peek does not create a panel session', () => {
    expect(peekWorkbenchPanelLayout('ws-panels')).toBeUndefined();
  });

  test('distinguishes empty problems and output from load failure', () => {
    expect(getWorkbenchProblems('ws-panels').status).toBe('empty');
    expect(getWorkbenchOutput('ws-panels').status).toBe('empty');
    setWorkbenchProblems('ws-panels', { status: 'failure', errorMessage: 'diagnostics unavailable' });
    setWorkbenchOutput('ws-panels', { status: 'failure', errorMessage: 'channel unavailable' });
    expect(getWorkbenchProblems('ws-panels')).toEqual({
      status: 'failure',
      errorMessage: 'diagnostics unavailable',
    });
    expect(getWorkbenchOutput('ws-panels')).toEqual({
      status: 'failure',
      errorMessage: 'channel unavailable',
    });
    setWorkbenchProblems('ws-panels', { status: 'empty' });
    setWorkbenchOutput('ws-panels', { status: 'empty' });
    expect(getWorkbenchProblems('ws-panels').status).toBe('empty');
    expect(getWorkbenchOutput('ws-panels').status).toBe('empty');
  });

  test('showing a panel does not invent problem or output records', () => {
    showWorkbenchPanel('ws-panels', 'changes');
    expect(peekWorkbenchPanelLayout('ws-panels')?.visible).toBe(true);
    expect(peekWorkbenchPanelLayout('ws-panels')?.activePanelId).toBe('changes');
    expect(getWorkbenchProblems('ws-panels').status).toBe('empty');
  });
});
