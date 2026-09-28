import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCompactionWatchdog } from "../../src/compaction-watchdog.js";

const settings = { enabled: true, streamIdleMs: 20, responseWaitMs: 50, maxRetries: 1 };

describe("compaction watchdog", () => {
  it("waits for a complete non-streaming response before declaring a stall", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = 0;
    const watchdog = createCompactionWatchdog(settings, () => { aborted += 1; });
    watchdog.start();
    const work = watchdog.race(new Promise<void>(() => undefined));
    t.mock.timers.tick(49);
    assert.equal(aborted, 0);
    t.mock.timers.tick(1);
    await assert.rejects(work, (error: { code?: string }) => error.code === "compaction_stalled");
    assert.equal(aborted, 1);
    watchdog.dispose();
  });

  it("resets the shorter idle clock on streaming progress and restores the response clock for the next turn", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = 0;
    const watchdog = createCompactionWatchdog(settings, () => { aborted += 1; });
    watchdog.start();
    const work = watchdog.race(new Promise<void>(() => undefined));
    t.mock.timers.tick(40);
    watchdog.streamed();
    t.mock.timers.tick(19);
    assert.equal(aborted, 0);
    watchdog.streamed();
    t.mock.timers.tick(19);
    assert.equal(aborted, 0);
    watchdog.waiting();
    t.mock.timers.tick(49);
    assert.equal(aborted, 0);
    t.mock.timers.tick(1);
    await assert.rejects(work, /no response for 50ms/);
    assert.equal(aborted, 1);
    watchdog.dispose();
  });

  it("does not create a deadline when recovery is disabled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const watchdog = createCompactionWatchdog({ ...settings, enabled: false }, () => { aborted = true; });
    watchdog.start();
    t.mock.timers.tick(100);
    assert.equal(aborted, false);
    assert.equal(await watchdog.race(Promise.resolve("complete")), "complete");
    watchdog.dispose();
  });
});
