import type { BrowserFrameInfo, BrowserInputRequest, BrowserUserInput } from '@varin/protocol';

/** Human input has one ordered, bounded lane. Only unsent motion is replaceable;
 * presses, releases, IME commits and unknown effects are never replayed. */
export function createBrowserInputQueue(options: {
  frame(): BrowserFrameInfo | undefined;
  send(request: BrowserInputRequest): Promise<unknown>;
  failed(error: unknown): void;
}) {
  const queue: BrowserInputRequest[] = [];
  let active: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let stopped = false, failed = false, generation = 0;
  const drain = () => {
    if (active || stopped || failed || !queue.length) return;
    const request = queue.shift()!, dispatchedGeneration = generation;
    // Preserve one transport lane through termination as well as ordinary input.
    // Sending release concurrently can otherwise arrive before its original press.
    active = Promise.resolve().then(() => options.send(request)).then(() => {}, error => {
      if (generation !== dispatchedGeneration) return;
      failed = true; queue.length = 0; options.failed(error);
    });
    void active.finally(() => { active = undefined; drain(); });
  };
  const enqueue = (input: BrowserUserInput) => {
    if (stopped || failed) return;
    const frame = options.frame(); if (!frame) return;
    const request: BrowserInputRequest = { pageId: frame.pageId, pageGeneration: frame.pageGeneration, streamId: frame.streamId,
      controlEpoch: frame.controlEpoch, frameSequence: frame.sequence, input };
    const last = queue.at(-1);
    if (input.type === 'pointer' && input.phase === 'move' && last?.input.type === 'pointer' && last.input.phase === 'move' && last.controlEpoch === request.controlEpoch) queue[queue.length - 1] = request;
    else if (queue.length >= 64) { failed = true; queue.length = 0; options.failed(new Error('Browser input is backlogged. Take control again before continuing.')); }
    else queue.push(request);
    void drain();
  };
  return { enqueue,
    async settled() { while (active) await active; },
    resume() { if (stopped) return; generation++; failed = false; queue.length = 0; },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true; queue.length = 0;
      const frame = options.frame();
      stopping = (active ?? Promise.resolve()).then(async () => {
        if (frame) await options.send({ pageId: frame.pageId, pageGeneration: frame.pageGeneration,
          streamId: frame.streamId, controlEpoch: frame.controlEpoch, frameSequence: frame.sequence, input: { type: 'release' } });
      }).catch(error => { options.failed(error); });
      return stopping;
    },
  };
}
export const browserModifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
