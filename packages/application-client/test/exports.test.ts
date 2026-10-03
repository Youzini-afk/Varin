import { test } from "node:test";
import assert from "node:assert/strict";

test("DocumentsError preserves reason and status", async () => {
  const { DocumentsError } = await import("../src/index.js");
  const error = new DocumentsError("test", { reason: "untrusted", status: 403 });
  assert.equal(error.reason, "untrusted");
  assert.equal(error.status, 403);
  assert.equal(error.name, "DocumentsError");
});

test("relay activation fails explicitly when a surface did not register its lifecycle", async () => {
  const { activateRelayTunnel } = await import("../src/index.js");
  assert.throws(() => activateRelayTunnel({
    relayUrl: "wss://relay.example.test",
    serverId: "server-1",
    hostEncPubJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  }), /lifecycle is not registered/);
});
