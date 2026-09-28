import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { NetworkDiagnosisResult } from "@varin/protocol";

const NetworkDiagParams = Type.Object({
  url: Type.String({ description: "URL to probe, e.g. https://example.com/path" }),
});

const formatDiagnosis = (r: NetworkDiagnosisResult): string => {
  const lines: string[] = [];
  lines.push(`request decision: ${r.decision}${r.reason ? ` (${r.reason})` : ""}`);
  const proxyBits = r.policy.mode === "proxy"
    ? `proxy ${r.policy.proxyOrigin ?? "?"}${r.policy.proxyAuth ? ` (${r.policy.proxyAuth} auth)` : ""}`
    : r.policy.mode === "system" ? "system network" : "direct";
  lines.push(`egress: ${proxyBits} [policy ${r.policy.source}]${r.policy.invalid ? ` INVALID: ${r.policy.invalid}` : ""}`);
  if (r.policy.noProxy.length > 0) lines.push(`no_proxy entries: ${r.policy.noProxy.join(", ")}`);
  const addressExplanation = {
    "not-run": "not run because the static target check stopped the request",
    public: "public in this diagnostic sample; fetch checks again on its connection",
    blocked: "blocked in this diagnostic sample; fetch checks again on its connection",
    "dns-error": "local DNS failed in this diagnostic sample",
    "proxy-side-unverified": "unverified: the proxy resolves the target, so Host cannot classify its final address",
    "system-managed": "the executing device's network stack resolves and routes this address",
  }[r.addressCheck];
  lines.push(`address check: ${addressExplanation}`);
  if (r.addresses?.length) lines.push(`addresses: ${r.addresses.map((a) => `${a.address}(${a.class})`).join(", ")}`);
  if (r.lookupError) lines.push(`local lookup: ${r.lookupError}`);
  return lines.join("\n");
};

/**
 * Read-only outbound-network diagnostics: reports the effective egress
 * policy, the current allow/block decision, and a diagnostic address sample
 * (local classes or proxy-side). It never performs the fetch and never
 * mutates proxy or credential settings.
 */
export function createNetworkDiagnosticsTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "network_diag",
    label: "Network Diagnostics",
    description:
      "Probe how an outbound request would leave the executing Host: effective egress policy (proxy/direct, " +
      "NO_PROXY), request decision, and a separate diagnostic address check. " +
      "Proxy-side target DNS is resolved by the configured proxy; desktop auto mode uses the system proxy/PAC stack. " +
      "Read-only — never fetches the URL or changes settings.",
    promptSnippet: "network_diag: inspect outbound network policy and resolution for a URL (read-only)",
    promptGuidelines: [
      "Use network_diag to inspect static blocks, local DNS, and proxy routing; it does not test TLS or connect to the target.",
      "Reported proxyOrigin is sanitized (no credentials); the tool cannot change proxy or credential settings.",
    ],
    parameters: NetworkDiagParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("network.diagnose", { url: params.url });
        return {
          content: [{ type: "text", text: formatDiagnosis(result) }],
          details: { kind: "network_diag", decision: result.decision, addressCheck: result.addressCheck },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `network_diag error: ${error instanceof Error ? error.message : String(error)}` }],
          details: { kind: "network_diag", status: "failed" },
        };
      }
    },
  });
}
