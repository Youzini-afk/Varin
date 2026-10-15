import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultVarinExtensionServiceRoutingDocument,
  resolveVarinExtensionServiceRouting,
  parseVarinExtensionServiceRoutingRule,
  parseVarinExtensionServiceRoutingContext,
} from "../src/index.js";

const candidates = [
  { providerId: "alpha-generation-2", providerKey: "dev.alpha:host:memory@1" },
  { providerId: "beta-generation-4", providerKey: "dev.beta:host:memory@1" },
];

test("Thread, branch and source Run routing remain separate native identities", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = [
    { scope: { threadId: "thread-a" }, providerKeys: [candidates[0]!.providerKey] },
    { scope: { threadId: "thread-a", branchId: "branch-a" }, providerKeys: [candidates[1]!.providerKey] },
    { scope: { threadId: "thread-a", branchId: "branch-a", sourceRunId: "run-a" }, providerKeys: [candidates[0]!.providerKey] },
  ].map(rule => ({ ...rule, allowFallback: false, serviceId: "memory", version: 1 }));
  const resolve = (context: { threadId: string; branchId: string; sourceRunId: string }) =>
    resolveVarinExtensionServiceRouting({ candidates, document, context, serviceId: "memory", version: 1 });
  assert.deepEqual(resolve({ threadId: "thread-a", branchId: "branch-a", sourceRunId: "run-a" }).providerKeys, [candidates[0]!.providerKey]);
  assert.deepEqual(resolve({ threadId: "thread-a", branchId: "branch-a", sourceRunId: "run-b" }).providerKeys, [candidates[1]!.providerKey]);
  assert.deepEqual(resolve({ threadId: "thread-a", branchId: "branch-b", sourceRunId: "run-a" }).providerKeys, [candidates[0]!.providerKey]);
  assert.equal(resolve({ threadId: "thread-b", branchId: "branch-a", sourceRunId: "run-a" }).status, "ambiguous");
  assert.throws(() => parseVarinExtensionServiceRoutingContext({ sessionId: "thread-a" }), /Unknown service routing context field/);
  assert.throws(() => parseVarinExtensionServiceRoutingContext({ threadId: "thread-a", branchId: " " }), /non-empty string/);
});

test("service routing resolves the most specific matching scope with a stable provider key", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: false,
      providerKeys: [candidates[0]!.providerKey],
      scope: { userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKeys: [candidates[1]!.providerKey],
      scope: { threadId: "thread-a", userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolveVarinExtensionServiceRouting({
    candidates,
    context: { threadId: "thread-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "resolved");
  assert.deepEqual(resolution.providerIds, ["beta-generation-4"]);
});

test("service routing falls through only when the missing selection allows fallback", () => {
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: true,
      providerKeys: ["dev.missing:host:memory@1"],
      scope: { threadId: "thread-a" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKeys: [candidates[0]!.providerKey],
      scope: { userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolveVarinExtensionServiceRouting({
    candidates,
    context: { threadId: "thread-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "resolved");
  assert.deepEqual(resolution.providerKeys, [candidates[0]!.providerKey]);
  assert.equal(resolution.diagnostics[0]?.code, "service_selection_fallback");

  document.rules[0]!.allowFallback = false;
  const unavailable = resolveVarinExtensionServiceRouting({
    candidates,
    context: { threadId: "thread-a", userId: "youzi" },
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
      providerKeys: [candidates[0]!.providerKey],
      scope: { threadId: "thread-a", userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKeys: [candidates[1]!.providerKey],
      scope: { threadId: "thread-a", workspaceId: "/workspace" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolveVarinExtensionServiceRouting({
    candidates,
    context: { threadId: "thread-a", userId: "youzi", workspaceId: "/workspace" },
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
  assert.equal(resolveVarinExtensionServiceRouting(input).diagnostics[0]?.code, "service_selection_single_required");
  assert.deepEqual(resolveVarinExtensionServiceRouting({ ...input, composition: "ordered" }).providerIds,
    [candidates[1]!.providerId, candidates[0]!.providerId]);
  rule.providerKeys = [candidates[0]!.providerKey];
  assert.equal(resolveVarinExtensionServiceRouting(input).status, "resolved");
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
    scope: { threadId: "session", userId: "default" }, serviceId: "memory", version: 1 };
  document.rules = [rule];
  const input = { candidates: ordered, document, context: { threadId: "session", userId: "default", projectId: "project" },
    serviceId: "memory", version: 1, composition: "ordered" as const };
  assert.equal(resolveVarinExtensionServiceRouting({ ...input, candidates: ordered.slice(0, 1) }).status, "unavailable");
  assert.equal(resolveVarinExtensionServiceRouting({ ...input, candidates }).diagnostics[0]?.code, "service_selection_composition_unsupported");
  document.rules.push({ ...rule, providerKeys: [...rule.providerKeys].reverse(), scope: { threadId: "session", projectId: "project" } });
  assert.equal(resolveVarinExtensionServiceRouting(input).status, "ambiguous");
  assert.throws(() => parseVarinExtensionServiceRoutingRule({ ...rule, providerKey: candidates[0]!.providerKey }));
  assert.throws(() => parseVarinExtensionServiceRoutingRule({ ...rule, providerKeys: ["same", "same"] }));
  document.rules = [{ ...rule, allowFallback: true, providerKeys: ["missing"] },
    { allowFallback: false, providerKeys: [candidates[0]!.providerKey], serviceId: "memory", version: 1, scope: { userId: "default" } }];
  assert.deepEqual(resolveVarinExtensionServiceRouting(input).providerIds, [candidates[0]!.providerId]);
});
