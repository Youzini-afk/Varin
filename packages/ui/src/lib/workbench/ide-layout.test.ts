import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IDE_WORKBENCH_LAYOUT,
  IDE_LAYOUT_NODE_IDS,
  parseIdeWorkbenchLayout,
  projectIdeWorkbenchLayout,
  updateIdeLayoutNode,
} from './ide-layout';

describe('IDE workbench layout document', () => {
  test('the distribution default is a split/stack/editor graph', () => {
    const parsed = parseIdeWorkbenchLayout(structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT));
    expect(parsed.rootId).toBe(IDE_LAYOUT_NODE_IDS.root);
    expect(parsed.nodes[IDE_LAYOUT_NODE_IDS.editor]?.kind).toBe('editor-area');
    const projection = projectIdeWorkbenchLayout(parsed);
    expect(projection.activity).toBe('explorer');
    expect(projection.primaryVisible).toBe(true);
    expect(projection.secondaryVisible).toBe(true);
  });

  test('migrates retired secondary views to sessions without dropping extension views', () => {
    const legacy = structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT);
    const secondary = legacy.nodes[IDE_LAYOUT_NODE_IDS.secondary];
    if (!secondary || secondary.kind !== 'stack') throw new Error('expected secondary stack');
    secondary.activeViewId = 'fleet';
    secondary.viewIds = ['agent', 'context', 'fleet', 'recovery', 'example.extension-view'];

    const parsed = parseIdeWorkbenchLayout(legacy);
    const migrated = parsed.nodes[IDE_LAYOUT_NODE_IDS.secondary];
    expect(migrated?.kind).toBe('stack');
    expect(migrated?.kind === 'stack' ? migrated.activeViewId : undefined).toBe('session');
    expect(migrated?.kind === 'stack' ? migrated.viewIds : []).toEqual([
      'session',
      'example.extension-view',
    ]);
  });

  test('the retired context view no longer survives as a secondary view', () => {
    const legacy = structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT);
    const secondary = legacy.nodes[IDE_LAYOUT_NODE_IDS.secondary];
    if (!secondary || secondary.kind !== 'stack') throw new Error('expected secondary stack');
    secondary.activeViewId = 'context';
    secondary.viewIds = ['session', 'context'];

    const migrated = parseIdeWorkbenchLayout(legacy).nodes[IDE_LAYOUT_NODE_IDS.secondary];
    expect(migrated?.kind === 'stack' ? migrated.activeViewId : undefined).toBe('session');
    expect(migrated?.kind === 'stack' ? migrated.viewIds : []).toEqual(['session']);
  });

  test('a surviving extension view keeps its active selection', () => {
    const legacy = structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT);
    const secondary = legacy.nodes[IDE_LAYOUT_NODE_IDS.secondary];
    if (!secondary || secondary.kind !== 'stack') throw new Error('expected secondary stack');
    secondary.activeViewId = 'example.extension-view';
    secondary.viewIds = ['session', 'example.extension-view'];

    const migrated = parseIdeWorkbenchLayout(legacy).nodes[IDE_LAYOUT_NODE_IDS.secondary];
    expect(migrated?.kind === 'stack' ? migrated.activeViewId : undefined).toBe('example.extension-view');
  });

  test('missing references and cycles are malformed rather than rewritten to defaults', () => {
    const missing = structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT);
    const root = missing.nodes[IDE_LAYOUT_NODE_IDS.root];
    if (!root || root.kind !== 'split') throw new Error('expected root split');
    root.children[0] = 'missing.node';
    expect(() => parseIdeWorkbenchLayout(missing)).toThrow('missing node');

    const cyclic = structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT);
    const center = cyclic.nodes[IDE_LAYOUT_NODE_IDS.center];
    if (!center || center.kind !== 'split') throw new Error('expected center split');
    center.children[0] = IDE_LAYOUT_NODE_IDS.root;
    expect(() => parseIdeWorkbenchLayout(cyclic)).toThrow('cycle');
  });

  test('stack visibility and active views project without deleting other view references', () => {
    const primary = DEFAULT_IDE_WORKBENCH_LAYOUT.nodes[IDE_LAYOUT_NODE_IDS.primary];
    if (!primary || primary.kind !== 'stack') throw new Error('expected primary stack');
    const document = updateIdeLayoutNode(structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT), {
      ...primary,
      activeViewId: 'git',
      visible: false,
    });
    const projection = projectIdeWorkbenchLayout(parseIdeWorkbenchLayout(document));
    expect(projection.activity).toBe('git');
    expect(projection.primaryVisible).toBe(false);
    const updatedPrimary = document.nodes[IDE_LAYOUT_NODE_IDS.primary];
    expect(updatedPrimary?.kind).toBe('stack');
    expect(updatedPrimary?.kind === 'stack' ? updatedPrimary.viewIds : []).toEqual([
      'explorer', 'search', 'git', 'run', 'extensions',
    ]);
  });
});
