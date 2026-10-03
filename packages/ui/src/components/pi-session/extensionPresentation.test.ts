import { describe, expect, test } from 'vitest';
import {
  parseExtensionStatus,
  parseSubagentNotifications,
  parseSubagentRun,
  projectToolCalls,
} from './extensionPresentation';

describe('Pi extension presentation', () => {
  test('combines codemode model usage with native tool receipts without repeating calls', () => {
    const result = projectToolCalls({
      toolName: 'codemode',
      nestedCalls: { complete: true, calls: [{ id: 'script/1', name: 'read', status: 'error', error: 'denied' }] },
      details: { calls: [
        { id: 'script/1', name: 'read', status: 'ok', durationMs: 12 },
        { id: 'script/models/1', name: 'models.generateImages', args: 'images/model', status: 'ok', durationMs: 50, cost: 0.05 },
        { id: 'script/models/2', name: 'models.classify', args: 'classifier/model', status: 'running' },
        { id: 'malformed', name: 'unexpected', status: 'other' },
        { id: 'malformed-object', name: 'unexpected', status: { toString: null } },
      ] },
    });
    expect(result?.calls).toHaveLength(3);
    expect(result?.calls[0]?.name).toBe('read');
    expect(result?.calls[0]?.status).toBe('error');
    expect(result?.calls[0]?.error).toBe('denied');
    expect(result?.calls[1]?.model).toBe('images/model');
    expect(result?.calls[1]?.cost).toBe(0.05);
    expect(result?.calls[2]?.cost).toBeUndefined();
    expect(result?.calls[2]?.status).toBe('unfinished');
    expect(result?.complete).toBe(false);
  });
  test('reads live model rows from the native progress envelope without inventing usage', () => {
    const result = projectToolCalls({ toolName: 'codemode', details: {
      content: [], details: { calls: [
        { id: 'model/1', name: 'models.classify', status: 'running', args: 'typesafe/jev' },
      ] },
    } }, true);
    expect(result?.calls[0]?.model).toBe('typesafe/jev');
    expect(result?.calls[0]?.cost).toBeUndefined();
    expect(result?.complete).toBe(false);
  });
  test('projects live and completed subagent details without dropping agents', () => {
    const presentation = parseSubagentRun({
      details: {
        mode: 'parallel',
        progress: [
          {
            agent: 'scout',
            currentPath: 'src/runtime.ts',
            currentTool: 'read',
            durationMs: 1200,
            index: 0,
            recentOutput: ['Inspecting the runtime'],
            recentTools: [{ args: 'src/runtime.ts', endMs: 80, tool: 'read' }],
            status: 'running',
            task: 'Trace runtime ownership',
            tokens: 320,
            toolCount: 2,
          },
          {
            agent: 'reviewer',
            durationMs: 900,
            index: 1,
            recentOutput: [],
            recentTools: [],
            status: 'completed',
            task: 'Check the adapter',
            tokens: 180,
            toolCount: 1,
          },
        ],
        progressSummary: { durationMs: 1200, tokens: 500, toolCount: 3 },
        results: [
          { agent: 'scout', exitCode: 0, task: 'Trace runtime ownership', usage: { input: 200, output: 120 } },
          { agent: 'reviewer', exitCode: 0, finalOutput: 'Adapter is sound.', task: 'Check the adapter', usage: {} },
        ],
        runId: 'run-42',
      },
    });

    expect(presentation?.mode).toBe('parallel');
    expect(presentation?.runId).toBe('run-42');
    expect(presentation?.agents).toHaveLength(2);
    expect(presentation?.agents[0]?.agent).toBe('scout');
    expect(presentation?.agents[0]?.currentTool).toBe('read');
    expect(presentation?.agents[0]?.status).toBe('running');
    expect(presentation?.agents[0]?.tokens).toBe(320);
    expect(presentation?.agents[1]?.finalOutput).toBe('Adapter is sound.');
    expect(presentation?.toolCount).toBe(3);
  });

  test('unwraps slash result payloads and derives completed result status', () => {
    const presentation = parseSubagentRun({
      requestId: 'slash-1',
      result: {
        content: [{ text: 'done', type: 'text' }],
        details: {
          mode: 'single',
          results: [{ agent: 'worker', exitCode: 0, task: 'Implement it', usage: { input: 10, output: 12 } }],
        },
      },
    });

    expect(presentation?.agents[0]?.agent).toBe('worker');
    expect(presentation?.agents[0]?.status).toBe('completed');
    expect(presentation?.agents[0]?.task).toBe('Implement it');
    expect(presentation?.agents[0]?.tokens).toBe(22);
  });

  test('parses current single and grouped background notification wire formats', () => {
    const single = parseSubagentNotifications([
      'Background task completed: **scout** (1/2)',
      '',
      'Found the relevant call site.',
      '',
      'Session file: D:/sessions/scout.jsonl',
    ].join('\n'));
    expect(single?.[0]?.agent).toBe('scout');
    expect(single?.[0]?.resultPreview).toBe('Found the relevant call site.');
    expect(single?.[0]?.sessionLabel).toBe('session file');
    expect(single?.[0]?.status).toBe('completed');
    expect(single?.[0]?.taskInfo).toBe('(1/2)');

    const grouped = parseSubagentNotifications([
      'Background tasks completed (2): **scout** (1/2), **reviewer** (2/2)',
      '',
      '1. scout (1/2)',
      'Located the files.',
      '',
      '2. reviewer (2/2)',
      'Review passed.',
      'Parallel handoff: D:/handoff.md',
    ].join('\n'));
    expect(grouped).toHaveLength(2);
    expect(grouped?.[1]?.agent).toBe('reviewer');
    expect(grouped?.[1]?.handoffPath).toBe('D:/handoff.md');
    expect(grouped?.[1]?.resultPreview).toBe('Review passed.');
    expect(grouped?.[1]?.taskInfo).toBe('(2/2)');
  });

  test('prefers future structured notification details over display text', () => {
    const notification = parseSubagentNotifications('new display format', {
      agent: 'builder',
      durationMs: 1250,
      resultPreview: 'Built successfully.',
      status: 'completed',
    })?.[0];
    expect(notification?.agent).toBe('builder');
    expect(notification?.durationMs).toBe(1250);
    expect(notification?.resultPreview).toBe('Built successfully.');
  });

  test('recognizes Magic Context persisted status entries and keeps details', () => {
    expect(parseExtensionStatus('ctx-status', {
      details: { tokens: 1234 },
      level: 'warning',
      text: 'Context is approaching the configured threshold.',
      title: 'Magic Context',
    })).toEqual({
      details: { tokens: 1234 },
      level: 'warning',
      text: 'Context is approaching the configured threshold.',
      title: 'Magic Context',
    });
    expect(parseExtensionStatus('another-extension', { text: 'x', title: 'x' })).toBeUndefined();
  });
});
