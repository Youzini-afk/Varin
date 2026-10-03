import { describe, expect, test } from 'vitest';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import { tryParseJsonOutput } from '../toolRenderers';
import { getStreamingThrottleText } from '../../hooks/useStreamingTextThrottle';
import { getStreamingOutputAppend, getToolOutput, renderTerminalOutput } from './toolOutput';

describe('getToolOutput', () => {
    test('prefers authoritative state output', () => {
        expect(getToolOutput('bash', 'final output', 'streamed output')).toBe('final output');
        expect(getToolOutput('bash', '', 'streamed output')).toBe('');
    });

    test('falls back to streamed metadata output for bash', () => {
        expect(getToolOutput('bash', undefined, 'streamed output')).toBe('streamed output');
        expect(getToolOutput('bash', undefined, '')).toBe(undefined);
    });

    test('does not expose metadata output for other tools', () => {
        expect(getToolOutput('read', undefined, 'metadata output')).toBe(undefined);
    });
});

describe('renderTerminalOutput', () => {
    test('renders final progress and removes ANSI styling', () => {
        expect(renderTerminalOutput('Downloading 10%\r\u001B[2K\u001B[32mDownloading 90%\u001B[0m')).toBe('Downloading 90%');
    });

    test('applies cursor movement and line erasure', () => {
        expect(renderTerminalOutput('First\nWorking\u001B[1A\r\u001B[2KDone\n')).toBe('Done\nWorking');
        expect(renderTerminalOutput('Hello World\u001B[6G\u001B[1K')).toBe('      World');
    });

    test('does not let terminal cursor coordinates allocate unbounded output', () => {
        const output = renderTerminalOutput('\u001B[999999999;999999999Hdone');
        expect(output.endsWith('done')).toBe(true);
        expect(output.length).toBeLessThanOrEqual(100_004);
    });
});

describe('getStreamingOutputAppend', () => {
    test('returns only newly appended output', () => {
        expect(getStreamingOutputAppend('first\n', 'first\nsecond\n')).toBe('second\n');
    });

    test('requires replacement when output is rewritten or shortened', () => {
        expect(getStreamingOutputAppend('progress 10%', 'progress 20%')).toBe(undefined);
        expect(getStreamingOutputAppend('long output', 'short')).toBe(undefined);
    });
});

describe('streaming output transitions', () => {
    test('allows bash snapshots to be rewritten or shortened while running', () => {
        expect(getStreamingThrottleText('progress 10%', 'progress 20%', true, true)).toBe('progress 20%');
        expect(getStreamingThrottleText('long output', 'short', true, true)).toBe('short');
    });

    test('preserves monotonic streaming text by default', () => {
        expect(getStreamingThrottleText('long output', 'short', true, false)).toBe('long output');
    });
});

describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});

describe('Varin tool output', () => {
    test('keeps the result envelope in the generic JSON rendering pipeline', () => {
        const result = {
            schemaVersion: 1,
            ok: true,
            action: 'projects.list',
            data: { projects: [] },
        };
        expect(tryParseJsonOutput(JSON.stringify(result))).toEqual({ data: result, isJson: true });
    });
});
