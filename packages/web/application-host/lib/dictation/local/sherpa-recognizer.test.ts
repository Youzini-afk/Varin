import { describe, expect, it, vi } from 'vitest';
import { SherpaRealtimeTranscriptionSession, type SherpaOfflineRecognizerEngine } from './sherpa-recognizer.js';

describe('local dictation segment finalization', () => {
  it('reuses a decoded partial for identical audio, while decoding new audio and later segments', async () => {
    const decode = vi.fn((audio: Buffer) => `decoded ${audio.length}`);
    const session = new SherpaRealtimeTranscriptionSession({ engine: {
      sampleRate: 16000, decodePcm16: decode,
    } as unknown as SherpaOfflineRecognizerEngine });
    const transcripts: Array<{ transcript: string; isFinal: boolean }> = [];
    session.on('transcript', value => transcripts.push(value));
    await session.connect();
    session.appendPcm16(Buffer.alloc(320));
    const first = new Promise<void>(resolve => session.once('committed', resolve));
    session.commit(); await first;
    expect(decode).toHaveBeenCalledTimes(1);
    expect(transcripts.at(-1)).toMatchObject({ transcript: 'decoded 320', isFinal: true });
    session.appendPcm16(Buffer.alloc(320));
    await session.maybeDecode(true);
    expect(decode).toHaveBeenCalledTimes(2);
    session.appendPcm16(Buffer.alloc(320));
    const second = new Promise<void>(resolve => session.once('committed', resolve));
    session.commit(); await second;
    expect(decode).toHaveBeenCalledTimes(3);
    expect(transcripts.at(-1)).toMatchObject({ transcript: 'decoded 640', isFinal: true });
    session.clear();
    session.appendPcm16(Buffer.alloc(640));
    await session.maybeDecode(true);
    expect(decode).toHaveBeenCalledTimes(4);
    session.close();
  });
});
