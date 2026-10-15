import { test } from "node:test";
import assert from "node:assert/strict";

test("relay activation fails explicitly when a surface did not register its lifecycle", async () => {
  const { activateRelayTunnel } = await import("../src/index.js");
  assert.throws(() => activateRelayTunnel({
    relayUrl: "wss://relay.example.test",
    serverId: "server-1",
    hostEncPubJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  }), /lifecycle is not registered/);
});
