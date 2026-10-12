import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultVarinExtensionServiceRoutingDocument,
  resolveVarinExtensionServiceRouting,
  parseVarinExtensionServiceRoutingRule,
} from "../src/index.js";

const candidates = [
  { providerId: "alpha-generation-2", providerKey: "dev.alpha:host:memory@1" },
  { providerId: "beta-generation-4", providerKey: "dev.beta:host:memory@1" },
];

test("service routing resolves the most specific matching scope with a stable provider key", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: false,
      providerKey: candidates[0]!.providerKey,
      scope: { userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKey: candidates[1]!.providerKey,
      scope: { sessionId: "session-a", userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolveVarinExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.providerId, "beta-generation-4");
});

test("service routing falls through only when the missing selection allows fallback", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: true,
      providerKey: "dev.missing:host:memory@1",
      scope: { sessionId: "session-a" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKey: candidates[0]!.providerKey,
      scope: { userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolveVarinExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.providerKey, candidates[0]!.providerKey);
  assert.equal(resolution.diagnostics[0]?.code, "service_selection_fallback");

  document.rules[0]!.allowFallback = false;
  const unavailable = resolveVarinExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(unavailable.status, "unavailable");
});

test("equally specific conflicting rules are explicit instead of load-order dependent", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: false,
      providerKey: candidates[0]!.providerKey,
      scope: { sessionId: "session-a", userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKey: candidates[1]!.providerKey,
      scope: { sessionId: "session-a", workspaceId: "/workspace" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolveVarinExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi", workspaceId: "/workspace" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.diagnostics[0]?.code, "service_selection_scope_conflict");
});


test("ordered routing keeps explicit order and emptiness without changing single invocation", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  const ordered = candidates.map(candidate => ({ ...candidate, composition: "ordered" as const }));
  const rule = { allowFallback: true, providerKeys: [candidates[1]!.providerKey, candidates[0]!.providerKey],
    scope: { userId: "default" }, serviceId: "memory", version: 1 };
  document.rules = [rule];
  const input = { candidates: ordered, document, context: { userId: "default" }, serviceId: "memory", version: 1 };
  assert.equal(resolveVarinExtensionServiceRouting(input).diagnostics[0]?.code, "service_selection_collection_required");
  assert.deepEqual(resolveVarinExtensionServiceRouting({ ...input, composition: "ordered" }).providerIds,
    [candidates[1]!.providerId, candidates[0]!.providerId]);
  rule.providerKeys = [candidates[0]!.providerKey];
  assert.equal(resolveVarinExtensionServiceRouting(input).status, "unavailable");
  rule.providerKeys = [];
  const empty = resolveVarinExtensionServiceRouting({ ...input, composition: "ordered", defaultProviderKey: candidates[0]!.providerKey });
  assert.equal(empty.status, "resolved");
  assert.deepEqual(empty.providerIds, []);
  assert.equal(empty.matchedRule?.scope.userId, "default");
});

test("ordered routing reports conflicts, missing required members and undeclared composition", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  const ordered = candidates.map(candidate => ({ ...candidate, composition: "ordered" as const }));
  const rule = { allowFallback: false, providerKeys: candidates.map(candidate => candidate.providerKey),
    scope: { sessionId: "session", userId: "default" }, serviceId: "memory", version: 1 };
  document.rules = [rule];
  const input = { candidates: ordered, document, context: { sessionId: "session", userId: "default", projectId: "project" },
    serviceId: "memory", version: 1, composition: "ordered" as const };
  assert.equal(resolveVarinExtensionServiceRouting({ ...input, candidates: ordered.slice(0, 1) }).status, "unavailable");
  assert.equal(resolveVarinExtensionServiceRouting({ ...input, candidates }).diagnostics[0]?.code, "service_selection_composition_unsupported");
  document.rules.push({ ...rule, providerKeys: [...rule.providerKeys].reverse(), scope: { sessionId: "session", projectId: "project" } });
  assert.equal(resolveVarinExtensionServiceRouting(input).status, "ambiguous");
  assert.throws(() => parseVarinExtensionServiceRoutingRule({ ...rule, providerKey: candidates[0]!.providerKey }));
  assert.throws(() => parseVarinExtensionServiceRoutingRule({ ...rule, providerKeys: ["same", "same"] }));
  document.rules = [{ ...rule, allowFallback: true, providerKeys: ["missing"] },
    { allowFallback: false, providerKey: candidates[0]!.providerKey, serviceId: "memory", version: 1, scope: { userId: "default" } }];
  assert.equal(resolveVarinExtensionServiceRouting(input).providerId, candidates[0]!.providerId);
});
