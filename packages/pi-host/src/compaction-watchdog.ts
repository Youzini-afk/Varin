import type { CompactionRecoverySettings } from "@varin/protocol";
import { HostError } from "./errors.js";

/** A silent response and an interrupted stream have different deadlines. */
export function createCompactionWatchdog(settings: CompactionRecoverySettings, onStall: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let rejectStall!: (error: HostError) => void;
  const stall = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
  const arm = (phase: "response" | "stream"): void => {
    if (timer) clearTimeout(timer);
    if (!settings.enabled || stalled) return;
    const duration = phase === "stream" ? settings.streamIdleMs : settings.responseWaitMs;
    timer = setTimeout(() => {
      stalled = true;
      rejectStall(new HostError("compaction_stalled",
        `Compaction stalled: no ${phase === "stream" ? "stream progress" : "response"} for ${duration}ms`,
        { retryable: true }));
      try { onStall(); } catch { /* The deadline still has to release the parent. */ }
    }, duration);
  };
  return {
    start: () => arm("response"),
    streamed: () => arm("stream"),
    waiting: () => arm("response"),
    race: <T>(work: Promise<T>): Promise<T> => Promise.race([work, stall]),
    dispose: () => { if (timer) clearTimeout(timer); timer = undefined; },
  };
}
