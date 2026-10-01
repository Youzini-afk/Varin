import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FOUNDATIONAL_PI_PACKAGE_MANIFEST,
  type PackageBootstrapResult,
  type PackageDescriptor,
} from "@varin/protocol";
import {
  reconcileFoundationalPackages,
  type PackageProvisioningReceiptDocument,
  type PackageProvisioningReceiptStore,
} from "../src/index.js";

const defaultReceipt = (): PackageProvisioningReceiptDocument => ({
  autoInstallNew: true,
  entries: {},
  manifestRevisionSeen: 0,
  version: 1,
});

function fakeStore(initial = defaultReceipt()): {
  document(): PackageProvisioningReceiptDocument;
  store: PackageProvisioningReceiptStore;
} {
  let document = structuredClone(initial);
  return {
    document: () => document,
    store: {
      transact: async (mutator: (current: PackageProvisioningReceiptDocument) => Promise<{
        document?: PackageProvisioningReceiptDocument;
        result: unknown;
      }>) => {
        const transaction = await mutator(structuredClone(document));
        document = transaction.document ?? document;
        return transaction.result;
      },
    } as unknown as PackageProvisioningReceiptStore,
  };
}

const descriptor = (
  source: string,
  options: Partial<PackageDescriptor> = {},
): PackageDescriptor => ({
  enabled: true,
  installed: true,
  name: source.includes("mcp") ? "pi-mcp-adapter" : "pi-wtf",
  scope: "global",
  source,
  structured: false,
  ...options,
});

describe("foundational package reconcile", () => {
  it("uses native MCP by default and only installs the external adapter on explicit restore", async () => {
    const integration = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!;
    let packages: PackageDescriptor[] = []; let installs = 0;
    const store = fakeStore().store;
    const reconcile = (restore: boolean) => reconcileFoundationalPackages({
      integrations: [integration], manifestRevision: FOUNDATIONAL_PI_PACKAGE_MANIFEST.revision,
      receiptStore: store, listPackages: async () => packages,
      ...(restore ? { restoreIds: new Set([integration.id]) } : {}),
      bootstrapPackages: async () => { installs++; packages = [descriptor(integration.source)];
        return { packages, results: [{ source: integration.source, status: "installed" }] }; },
    });
    await reconcile(false); assert.equal(installs, 0);
    await reconcile(true); assert.equal(installs, 1);
    await reconcile(false); assert.equal(installs, 1, "a configured user choice is preserved");
  });
  it("adopts disabled or configured-broken packages offline without repairing them", async () => {
    const integration = { ...FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!, defaultProvision: true };
    let bootstrapCalls = 0;
    const reconcile = (candidate: PackageDescriptor) => reconcileFoundationalPackages({
      bootstrapPackages: async () => {
        bootstrapCalls += 1;
        throw new Error("must not install configured packages");
      },
      integrations: [integration],
      listPackages: async () => [candidate],
      manifestRevision: 1,
      receiptStore: fakeStore().store,
    });
    const disabled = await reconcile(descriptor(integration.source, { enabled: false }));
    const broken = await reconcile(descriptor(integration.source, { installed: false }));
    assert.equal(bootstrapCalls, 0);
    assert.equal(disabled.entries[0]?.observed, "disabled");
    assert.equal(broken.entries[0]?.observed, "configured_broken");
    assert.equal(disabled.state, "ready");
    assert.equal(broken.state, "degraded");
  });

  it("records a bootstrap failure when the Host still reports the package absent", async () => {
    const integration = { ...FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!, defaultProvision: true };
    const receipt = fakeStore();
    const batch: PackageBootstrapResult = {
      packages: [],
      results: [
        { error: "offline", source: integration.source, status: "failed" },
      ],
    };
    const result = await reconcileFoundationalPackages({
      bootstrapPackages: async () => batch,
      integrations: [integration],
      listPackages: async () => [],
      manifestRevision: 1,
      receiptStore: receipt.store,
    });
    assert.equal(result.entries[0]?.operation, "failed_retryable");
    assert.equal(receipt.document().entries.mcp?.lastObservedPresent, false);
    assert.equal(result.state, "degraded");
  });

  it("suppresses external removal until an explicit restore", async () => {
    const integration = { ...FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!, defaultProvision: true };
    const receipt = fakeStore({
      ...defaultReceipt(),
      entries: {
        mcp: {
          intent: "eligible",
          lastObservedPresent: true,
          provenance: "auto_managed",
          source: "https://github.com/old/pi-mcp-adapter.git",
        },
      },
      manifestRevisionSeen: 1,
    });
    let installs = 0;
    const suppressed = await reconcileFoundationalPackages({
      bootstrapPackages: async () => {
        installs += 1;
        throw new Error("suppressed packages must not install");
      },
      integrations: [integration],
      listPackages: async () => [],
      manifestRevision: 1,
      receiptStore: receipt.store,
    });
    assert.equal(suppressed.entries[0]?.intent, "suppressed");
    assert.equal(installs, 0);

    const restoredDescriptor = descriptor(integration.source);
    const restored = await reconcileFoundationalPackages({
      bootstrapPackages: async (sources) => {
        installs += 1;
        return {
          packages: [restoredDescriptor],
          results: [{ source: sources[0] as string, status: "installed" }],
        };
      },
      integrations: [integration],
      listPackages: async () => [],
      manifestRevision: 1,
      receiptStore: receipt.store,
      restoreIds: new Set(["mcp"]),
    });
    assert.equal(installs, 1);
    assert.equal(restored.entries[0]?.intent, "eligible");
    assert.equal(restored.entries[0]?.source, integration.source);
  });

  it("keeps an externally restored package visibly outside automatic management", async () => {
    const integration = { ...FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!, defaultProvision: true };
    const receipt = fakeStore({
      ...defaultReceipt(),
      entries: {
        mcp: {
          intent: "suppressed",
          lastObservedPresent: false,
          provenance: "auto_managed",
          source: integration.source,
        },
      },
      manifestRevisionSeen: 1,
    });
    const result = await reconcileFoundationalPackages({
      bootstrapPackages: async () => {
        throw new Error("an observed suppressed package must not install");
      },
      integrations: [integration],
      listPackages: async () => [descriptor(integration.source)],
      manifestRevision: 1,
      receiptStore: receipt.store,
    });
    assert.equal(result.entries[0]?.intent, "suppressed");
    assert.equal(result.entries[0]?.observed, "enabled");
    assert.equal(result.entries[0]?.operation, "action_required");
    assert.equal(result.state, "degraded");
  });

  it("uses autoInstallNew only as an introduced-revision cutoff", async () => {
    const integration = { ...FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!, defaultProvision: true };
    const receipt = fakeStore({ ...defaultReceipt(), autoInstallNew: false });
    let installs = 0;
    const result = await reconcileFoundationalPackages({
      bootstrapPackages: async () => {
        installs += 1;
        return { packages: [], results: [] };
      },
      integrations: [integration],
      listPackages: async () => [],
      manifestRevision: 1,
      receiptStore: receipt.store,
    });
    assert.equal(installs, 0);
    assert.equal(result.entries[0]?.intent, "policy_skipped");

    const installed = descriptor(integration.source);
    const restored = await reconcileFoundationalPackages({
      bootstrapPackages: async () => ({
        packages: [installed],
        results: [{ source: integration.source, status: "installed" }],
      }),
      integrations: [integration],
      listPackages: async () => [],
      manifestRevision: 1,
      receiptStore: receipt.store,
      restoreIds: new Set(["mcp"]),
    });
    assert.equal(restored.entries[0]?.intent, "eligible");
    assert.equal(restored.entries[0]?.observed, "enabled");
  });

  it("records the current cutoff before disabling future automatic additions", async () => {
    const integration = { ...FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0]!, defaultProvision: true };
    const receipt = fakeStore();
    const installed = descriptor(integration.source);
    let installs = 0;
    const result = await reconcileFoundationalPackages({
      bootstrapPackages: async () => {
        installs += 1;
        return {
          packages: [installed],
          results: [{ source: integration.source, status: "installed" }],
        };
      },
      integrations: [integration],
      listPackages: async () => [],
      manifestRevision: 1,
      receiptStore: receipt.store,
      setAutoInstallNew: false,
    });
    assert.equal(installs, 1);
    assert.equal(result.autoInstallNew, false);
    assert.equal(receipt.document().manifestRevisionSeen, 1);
    assert.equal(result.entries[0]?.provenance, "auto_managed");
  });
});
