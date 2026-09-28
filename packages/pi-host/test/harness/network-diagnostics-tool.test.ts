import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessRequestData, NetworkDiagnosisResult } from "@varin/protocol";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createNetworkDiagnosticsTool } from "../../src/harness/network-diagnostics-tool.js";

const policy = { version: 1, mode: "proxy" as const, source: "app" as const, proxyOrigin: "http://127.0.0.1:3128", noProxy: [] };

const runDiagnosis = async (diagnosis: NetworkDiagnosisResult) => {
  const emitted: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({ emit: (_event, data) => { emitted.push(data); }, sessionId: "test" });
  const tool = createNetworkDiagnosticsTool(bridge);
  const pending = tool.execute("diag-1", { url: diagnosis.url } as never, undefined as never, undefined as never, undefined as never);
  assert.equal(emitted[0]?.method, "network.diagnose");
  bridge.respond("test", emitted[0]!.requestId, { ok: true, result: diagnosis });
  const result = await pending;
  bridge.dispose();
  return {
    text: result.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n"),
    details: result.details as Record<string, unknown>,
  };
};

describe("network_diag", () => {
  it("does not present proxy-side DNS as a verified destination", async () => {
    const { text, details } = await runDiagnosis({
      url: "https://example.com/",
      policy,
      decision: "allowed",
      resolution: "proxy-side",
      addressCheck: "proxy-side-unverified",
    });
    assert.match(text, /request decision: allowed/);
    assert.match(text, /address check: unverified: the proxy resolves the target/);
    assert.deepEqual(details, { kind: "network_diag", decision: "allowed", addressCheck: "proxy-side-unverified" });
  });

  it("reports a blocked local DNS sample as a blocked request", async () => {
    const { text, details } = await runDiagnosis({
      url: "http://public-name.test/",
      policy: { version: 1, mode: "direct", source: "none", noProxy: [] },
      decision: "blocked",
      reason: "target resolves to a private address (fe90::1)",
      resolution: "local",
      addressCheck: "blocked",
      addresses: [{ address: "fe90::1", class: "private" }],
    });
    assert.match(text, /request decision: blocked/);
    assert.match(text, /address check: blocked in this diagnostic sample/);
    assert.match(text, /fe90::1\(private\)/);
    assert.deepEqual(details, { kind: "network_diag", decision: "blocked", addressCheck: "blocked" });
  });

  it("explains desktop system routing without guessing DNS addresses", async () => {
    const { text } = await runDiagnosis({
      url: "https://example.com/",
      policy: { version: 1, mode: "system", source: "none", noProxy: [] },
      decision: "allowed", resolution: "system", addressCheck: "system-managed",
    });
    assert.match(text, /system network/);
    assert.match(text, /device's network stack resolves/);
  });
});
