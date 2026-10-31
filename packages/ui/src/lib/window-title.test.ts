import { expect, test } from 'vitest';
import { resolveWindowTitle } from './window-title';

const project = { id: 'project', path: 'D:\\project\\opencr', label: 'opencr' };
test('uses project identity across execution roots and preserves the chosen label', () => {
  expect(resolveWindowTitle({ projects: [project], activeProjectId: project.id,
    directory: 'C:/runtime/workspaces/674b57c7-d2d6-4e7c-a9ef-4c0be431b663', instanceLabel: null }))
    .toBe('Varin | opencr');
});
test('an unassigned internal directory and the project-independent Bot keep the product title', () => {
  expect(resolveWindowTitle({ projects: [], activeProjectId: null, directory: 'C:/runtime/674b57c7-d2d6-4e7c-a9ef-4c0be431b663', instanceLabel: null })).toBe('Varin');
  expect(resolveWindowTitle({ projects: [project], activeProjectId: project.id, instanceLabel: 'Remote', bot: true })).toBe('Varin | Remote');
});
test('matches registered Windows folders across separators and case', () => {
  expect(resolveWindowTitle({ projects: [project], activeProjectId: null, directory: 'd:/PROJECT/opencr/src', instanceLabel: null })).toBe('Varin | opencr');
  expect(resolveWindowTitle({ projects: [{ ...project, additionalPaths: ['E:\\papers'] }], activeProjectId: null, directory: 'e:/papers/readme', instanceLabel: null })).toBe('Varin | opencr');
});
