import { describe, it, expect, vi, afterEach } from "vitest";
import { createStorePersistence } from "./persistence.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const flush = vi.fn();
  const close = vi.fn();
  const onError = vi.fn();
  const persistence = createStorePersistence({
    flush, close, onError, enqueue: async (work) => work(),
  });
  return { persistence, flush, close, onError };
}

describe("knowledge persistence boundary", () => {
  it("shares a checkpoint and withholds notifications until it succeeds", async () => {
    const { persistence: p, flush } = fixture();
    const notify = vi.fn();
    await p.batch(async () => {
      p.changed(); p.commit(); p.afterCommit(notify);
      p.changed(); p.commit(); p.afterCommit(notify);
      expect(flush).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("a durable write covers the pending derived checkpoint, with no empty flush", async () => {
    vi.useFakeTimers();
    const { persistence: p, flush } = fixture();
    p.changed(); p.defer();
    p.changed(); p.commit();
    await vi.advanceTimersByTimeAsync(31_000);
    p.commit();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("ongoing builds use the existing deadline across slow batches and completion commits once", async () => {
    vi.useFakeTimers();
    const { persistence: p, flush } = fixture();
    p.changed(); p.defer({ busy: true });
    await vi.advanceTimersByTimeAsync(10_000);
    p.changed(); p.defer({ busy: true });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    p.changed(); p.defer({ busy: true });
    p.commit();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("failed checkpoints keep dirty data and notifications, and recover before a read", async () => {
    vi.useFakeTimers();
    const { persistence: p, flush } = fixture();
    const notify = vi.fn();
    flush.mockImplementationOnce(() => { throw new Error("disk fixture failure"); });
    await expect(p.batch(async () => {
      p.changed(); p.commit(); p.afterCommit(notify);
    })).rejects.toThrow("disk fixture failure");
    expect(notify).not.toHaveBeenCalled();
    await p.batch(async () => {
      expect(flush).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("reports and retries a deferred failure instead of losing the dirty flag", async () => {
    vi.useFakeTimers();
    const { persistence: p, flush, onError } = fixture();
    flush.mockImplementationOnce(() => { throw new Error("deferred fixture failure"); });
    p.changed(); p.defer();
    await vi.advanceTimersByTimeAsync(250);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(flush).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("uses native close once and allows a failed close to be retried", async () => {
    vi.useFakeTimers();
    const { persistence: p, close, flush } = fixture();
    const notify = vi.fn();
    p.changed(); p.defer(); p.afterCommit(notify);
    close.mockImplementationOnce(() => { throw new Error("close fixture failure"); });
    expect(() => p.close()).toThrow("close fixture failure");
    expect(notify).not.toHaveBeenCalled();
    p.close(); p.close();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(flush).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(() => p.changed()).toThrow("closed");
  });
});
