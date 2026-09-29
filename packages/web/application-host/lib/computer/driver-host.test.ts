import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDriverSession, computerDriverDir } from "./driver-host.js";

/**
 * Driver supervisor tests run against a real child process speaking the
 * line-delimited protocol — the same contract the PowerShell/Python drivers
 * implement — so queueing, correlation, and exit handling are exercised for
 * real, not against a mock of the module under test.
 */

// Echoes each request with ok + the tool name; supports a "hang" op that never
// replies and an "exit" op that terminates the process.
const ECHO_DRIVER = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.tool === "hang") continue;
    if (message.tool === "awaitflag") {
      // Polls its own cancel flag file — proves cancel() writes where the
      // driver actually looks, at the same path shape real drivers poll.
      const fs = require("fs");
      const path = require("path");
      const flag = path.join(process.env.VARIN_DRIVER_CANCEL_DIR || "", message.id + ".cancel");
      const poll = setInterval(() => {
        if (fs.existsSync(flag)) {
          clearInterval(poll);
          process.stdout.write(JSON.stringify({ id: message.id, ok: false, cancelled: true, error: "cancelled" }) + "\\n");
        }
      }, 5);
      continue;
    }
    if (message.tool === "exit") process.exit(3);
    if (message.tool === "slow") { setTimeout(() => process.stdout.write(JSON.stringify({id:message.id,ok:true}) + "\\n"), 120); continue; }
    process.stdout.write(JSON.stringify({ id: message.id, ok: message.tool !== "fail", text: "did:" + message.tool, error: message.tool === "fail" ? "op failed" : undefined }) + "\\n");
  }
});
`;

const echoSpec = () => ({
  command: process.execPath,
  args: ["-e", ECHO_DRIVER],
});

describe("computer driver host (BC4)", () => {
  it("correlates concurrent requests and serializes them on the wire", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      const [a, b, c] = await Promise.all([
        driver.request({ tool: "click" }),
        driver.request({ tool: "scroll" }),
        driver.request({ tool: "press_key" }),
      ]);
      expect(a.text).toBe("did:click");
      expect(b.text).toBe("did:scroll");
      expect(c.text).toBe("did:press_key");
      expect(driver.alive()).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("a driver-side error resolves the op without poisoning later requests", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      const failed = await driver.request({ tool: "fail" });
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe("op failed");
      const after = await driver.request({ tool: "ping" });
      expect(after.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("an unexpected driver exit rejects the in-flight request and the next request respawns", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      const exitResult = await driver.request({ tool: "exit" }).catch((error: unknown) => error);
      expect(exitResult).toBeInstanceOf(Error);
      expect((exitResult as Error).message).toMatch(/exit/i);
      // The supervisor respawns on demand rather than staying dead.
      const recovered = await driver.request({ tool: "ping" });
      expect(recovered.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("a wedged request times out, kills the driver, and frees the queue", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      await expect(driver.request({ tool: "hang" }, { timeoutMs: 300 }))
        .rejects.toThrow(/timed out/);
      const recovered = await driver.request({ tool: "ping" });
      expect(recovered.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("cancel() writes the in-flight request's flag file on the side-channel", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      expect(driver.cancel()).toBe(false);
      const inFlight = driver.request({ tool: "awaitflag" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(driver.cancel()).toBe(true);
      const response = await inFlight;
      expect(response.ok).toBe(false);
      expect(response.cancelled).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("dispose fails pending work and refuses new requests", async () => {
    const driver = createDriverSession(echoSpec());
    const wedged = driver.request({ tool: "hang" });
    const queued = driver.request({ tool: "click" });
    const rejected = Promise.allSettled([wedged, queued]);
    driver.dispose();
    expect((await rejected).every((result) => result.status === "rejected")).toBe(true);
    await expect(driver.request({ tool: "ping" })).rejects.toThrow(/disposed/);
    expect(driver.alive()).toBe(false);
  });

  it("starts each request budget at dispatch rather than timing out queued input that later executes", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      await driver.request({ tool: "ping" });
      const [slow, next] = await Promise.all([
        driver.request({ tool: "slow" }), driver.request({ tool: "click" }, { timeoutMs: 60 }),
      ]);
      expect(slow.ok).toBe(true);
      expect(next.text).toBe("did:click");
    } finally { driver.dispose(); }
  });

  it("ignores malformed lines on stdout without breaking correlation", async () => {
    const noisySpec = {
      command: process.execPath,
      args: ["-e", `
        process.stdout.write("not json at all\\n");
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf("\\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            process.stdout.write("garbage\\n" + JSON.stringify({ id: message.id, ok: true }) + "\\n");
          }
        });
      `],
    };
    const driver = createDriverSession(noisySpec);
    try {
      const response = await driver.request({ tool: "ping" });
      expect(response.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });
});

describe("computerDriverDir (BC9 packaging)", () => {
  it("env override wins and the fallback resolves real driver assets", () => {
    const original = process.env.VARIN_COMPUTER_DRIVER_DIR;
    try {
      process.env.VARIN_COMPUTER_DRIVER_DIR = "/override/dir";
      expect(computerDriverDir()).toBe("/override/dir");
      delete process.env.VARIN_COMPUTER_DRIVER_DIR;
      const resolved = computerDriverDir();
      // Source checkout or staged package copy — either way the Windows
      // driver script must exist at the resolved location.
      expect(existsSync(join(resolved, "windows", "driver-host.ps1"))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.VARIN_COMPUTER_DRIVER_DIR;
      else process.env.VARIN_COMPUTER_DRIVER_DIR = original;
    }
  });
});
