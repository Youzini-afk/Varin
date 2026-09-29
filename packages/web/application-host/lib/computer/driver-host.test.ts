import { describe, it, expect } from "vitest";
import { createDriverSession } from "./driver-host.js";

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
    if (message.tool === "exit") process.exit(3);
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

  it("dispose fails pending work and refuses new requests", async () => {
    const driver = createDriverSession(echoSpec());
    const wedged = driver.request({ tool: "hang" });
    driver.dispose();
    await expect(wedged).rejects.toThrow(/disposed/);
    await expect(driver.request({ tool: "ping" })).rejects.toThrow(/disposed/);
    expect(driver.alive()).toBe(false);
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
