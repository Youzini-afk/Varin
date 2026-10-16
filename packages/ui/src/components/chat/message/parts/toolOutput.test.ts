import { describe, expect, test } from 'vitest';
import { renderTerminalOutput } from './toolOutput';

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
