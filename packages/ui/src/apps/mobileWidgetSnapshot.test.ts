import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SessionSummary } from '@varin/protocol';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { buildMobileWidgetSnapshot } from './mobileWidgetSnapshot';

const session = (id: string, parentId?: string): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-03T00:00:00.000Z',
  cwd: 'D:/work',
  firstMessage: '',
  id,
  messageCount: 1,
  ...(parentId === undefined ? {} : { parentId }),
  persisted: true,
  sessionFile: `D:/sessions/${id}.jsonl`,
  updatedAt: '2026-08-03T01:00:00.000Z',
});

let previousSessions: ReturnType<typeof usePiSessionStore.getState>;
let previousProjects: ReturnType<typeof useProjectsStore.getState>;
let previousUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousSessions = usePiSessionStore.getState();
  previousProjects = useProjectsStore.getState();
  previousUI = useUIStore.getState();
});

afterEach(() => {
  usePiSessionStore.setState(previousSessions, true);
  useProjectsStore.setState(previousProjects, true);
  useUIStore.setState(previousUI, true);
});

describe('Pi mobile widget snapshot', () => {
  test('uses the Pi completion/error attention map and subtask preference', () => {
    usePiSessionStore.setState({
      attentionBySession: {
        child: { kind: 'error', updatedAt: 2 },
        parent: { kind: 'complete', updatedAt: 1 },
      },
      summaries: [session('parent'), session('child', 'parent')],
    });
    useProjectsStore.setState({ projects: [{ id: 'project-a', path: 'D:/work', label: 'Work' }] });
    useUIStore.setState({ notifyOnSubtasks: false });

    const withoutSubtasks = buildMobileWidgetSnapshot();
    expect(withoutSubtasks.attentionCount).toBe(1);
    expect(withoutSubtasks.recentSessions).toEqual([{
      id: 'parent',
      project: 'Work',
      title: '',
      unread: true,
    }]);

    useUIStore.setState({ notifyOnSubtasks: true });
    expect(buildMobileWidgetSnapshot().attentionCount).toBe(2);
  });
});
