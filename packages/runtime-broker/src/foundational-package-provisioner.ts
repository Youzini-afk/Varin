import {
  matchesFoundationalPackage,
  type FoundationalPiPackageId,
  type FoundationalPiPackageManifestEntry,
  type FoundationalPiPackageStatusEntry,
  type PackageBootstrapResult,
  type PackageDescriptor,
} from "@varin/protocol";
import {
  type PackageProvisioningReceiptDocument,
  type PackageProvisioningReceiptEntry,
  type PackageProvisioningReceiptEntries,
  PackageProvisioningReceiptStore,
} from "./package-provisioning-receipt-store.js";

export interface FoundationalPackageReconcileOptions {
  bootstrapPackages(sources: string[]): Promise<PackageBootstrapResult>;
  integrations: readonly FoundationalPiPackageManifestEntry[];
  listPackages(): Promise<PackageDescriptor[]>;
  manifestRevision: number;
  receiptStore: PackageProvisioningReceiptStore;
  restoreIds?: ReadonlySet<FoundationalPiPackageId>;
  setAutoInstallNew?: boolean;
}

export interface FoundationalPackageReconcileResult {
  autoInstallNew: boolean;
  entries: FoundationalPiPackageStatusEntry[];
  state: "ready" | "degraded";
}

interface PlannedEntry {
  entry: FoundationalPiPackageManifestEntry;
  prior: PackageProvisioningReceiptEntry | undefined;
}

function asReceiptEntry(value: unknown): PackageProvisioningReceiptEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as PackageProvisioningReceiptEntry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchingDescriptors(
  descriptorEntry: FoundationalPiPackageManifestEntry,
  packages: readonly PackageDescriptor[],
): PackageDescriptor[] {
  return packages.filter((descriptor) => (
    descriptor.scope === "global" && matchesFoundationalPackage(descriptorEntry, descriptor)
  ));
}

function mergeReceiptEntry(
  existing: unknown,
  status: FoundationalPiPackageStatusEntry,
  lastObservedPresent: boolean,
): PackageProvisioningReceiptEntry {
  const next = asReceiptEntry(existing) === undefined
    ? {} as Record<string, unknown>
    : { ...(existing as Record<string, unknown>) };
  next.intent = status.intent;
  next.lastObservedPresent = lastObservedPresent;
  next.provenance = status.provenance;
  delete next.source;
  if (status.source !== undefined) next.source = status.source;
  return next as PackageProvisioningReceiptEntry;
}

function observedStatus(
  manifestEntry: FoundationalPiPackageManifestEntry,
  descriptors: readonly PackageDescriptor[],
  prior: PackageProvisioningReceiptEntry | undefined,
): FoundationalPiPackageStatusEntry {
  const descriptor = descriptors[0] as PackageDescriptor;
  const intent = prior?.intent === "suppressed" ? "suppressed" : "eligible";
  const provenance = prior?.provenance === "auto_managed" ? "auto_managed" : "adopted";
  if (descriptors.length > 1) {
    return {
      error: "Multiple global Pi package sources match this foundational integration",
      id: manifestEntry.id,
      intent,
      observed: "source_conflict",
      operation: "action_required",
      provenance,
      source: descriptor.source,
    };
  }
  if (!descriptor.installed) {
    return {
      error: "The Pi package is configured but its installed artifact is missing",
      id: manifestEntry.id,
      intent,
      observed: "configured_broken",
      operation: "action_required",
      provenance,
      source: descriptor.source,
    };
  }
  return {
    ...(intent === "suppressed"
      ? { error: "The package is present but automatic foundational management remains suppressed" }
      : {}),
    id: manifestEntry.id,
    intent,
    observed: descriptor.enabled ? "enabled" : "disabled",
    operation: intent === "suppressed" ? "action_required" : "idle",
    provenance,
    source: descriptor.source,
  };
}

function isDegraded(entries: readonly FoundationalPiPackageStatusEntry[]): boolean {
  return entries.some((entry) => (
    entry.operation === "failed_retryable"
    || entry.operation === "action_required"
    || entry.observed === "incompatible"
    || entry.observed === "source_conflict"
  ));
}

function receiptWithEntries(
  current: PackageProvisioningReceiptDocument,
  entries: readonly FoundationalPiPackageStatusEntry[],
  manifestRevision: number,
): PackageProvisioningReceiptDocument {
  const nextEntries: PackageProvisioningReceiptEntries = { ...current.entries };
  for (const status of entries) {
    nextEntries[status.id] = mergeReceiptEntry(
      nextEntries[status.id],
      status,
      status.observed !== "missing",
    );
  }
  return {
    ...current,
    entries: nextEntries,
    manifestRevisionSeen: Math.max(current.manifestRevisionSeen, manifestRevision),
  };
}

export async function reconcileFoundationalPackages(
  options: FoundationalPackageReconcileOptions,
): Promise<FoundationalPackageReconcileResult> {
  return options.receiptStore.transact(async (persisted) => {
    const restored = options.restoreIds ?? new Set<FoundationalPiPackageId>();
    const preparedEntries: PackageProvisioningReceiptEntries = { ...persisted.entries };
    for (const id of restored) {
      const prior = asReceiptEntry(preparedEntries[id]);
      if (prior?.intent !== "suppressed" && prior?.intent !== "policy_skipped") continue;
      preparedEntries[id] = {
        ...prior,
        intent: "eligible",
        lastObservedPresent: false,
      };
    }
    const current: PackageProvisioningReceiptDocument = {
      ...persisted,
      ...(options.setAutoInstallNew === undefined
        ? {}
        : { autoInstallNew: options.setAutoInstallNew }),
      entries: preparedEntries,
      manifestRevisionSeen: options.setAutoInstallNew === undefined
        ? persisted.manifestRevisionSeen
        : Math.max(persisted.manifestRevisionSeen, options.manifestRevision),
    };

    let packages: PackageDescriptor[];
    try {
      packages = await options.listPackages();
    } catch (error) {
      const message = `Unable to read Pi package authority: ${errorMessage(error)}`;
      const entries = options.integrations.map((entry): FoundationalPiPackageStatusEntry => {
        const prior = asReceiptEntry(current.entries[entry.id]);
        return {
          error: message,
          id: entry.id,
          intent: prior?.intent ?? "eligible",
          observed: "missing",
          operation: "failed_retryable",
          provenance: prior?.provenance ?? "none",
          source: prior?.source ?? entry.source,
        };
      });
      return {
        document: current,
        result: { autoInstallNew: current.autoInstallNew, entries, state: "degraded" },
      };
    }

    const statuses = new Map<FoundationalPiPackageId, FoundationalPiPackageStatusEntry>();
    const planned: PlannedEntry[] = [];
    for (const entry of options.integrations) {
      const prior = asReceiptEntry(current.entries[entry.id]);
      const matches = matchingDescriptors(entry, packages);
      if (matches.length > 0) {
        statuses.set(entry.id, observedStatus(entry, matches, prior));
        continue;
      }
      if (prior?.intent === "suppressed") {
        statuses.set(entry.id, {
          id: entry.id,
          intent: "suppressed",
          observed: "missing",
          operation: "idle",
          provenance: prior.provenance,
          source: prior.source ?? entry.source,
        });
        continue;
      }
      if (prior?.lastObservedPresent === true && !restored.has(entry.id)) {
        statuses.set(entry.id, {
          id: entry.id,
          intent: "suppressed",
          observed: "missing",
          operation: "idle",
          provenance: prior.provenance,
          source: prior.source ?? entry.source,
        });
        continue;
      }
      if (
        prior?.intent === "policy_skipped"
        && !current.autoInstallNew
        && !restored.has(entry.id)
      ) {
        statuses.set(entry.id, {
          id: entry.id,
          intent: "policy_skipped",
          observed: "missing",
          operation: "idle",
          provenance: prior.provenance,
          source: prior.source ?? entry.source,
        });
        continue;
      }
      if (entry.defaultProvision === false && !restored.has(entry.id)) {
        statuses.set(entry.id, {
          id: entry.id, intent: "policy_skipped", observed: "missing", operation: "idle",
          provenance: prior?.provenance ?? "none", source: prior?.source ?? entry.source,
        });
        continue;
      }
      if (
        prior === undefined
        && !current.autoInstallNew
        && entry.introducedRevision > current.manifestRevisionSeen
        && !restored.has(entry.id)
      ) {
        statuses.set(entry.id, {
          id: entry.id,
          intent: "policy_skipped",
          observed: "missing",
          operation: "idle",
          provenance: "none",
          source: entry.source,
        });
        continue;
      }
      planned.push({ entry, prior });
      statuses.set(entry.id, {
        id: entry.id,
        intent: "eligible",
        observed: "missing",
        operation: "planned",
        provenance: prior?.provenance ?? "none",
        source: prior?.source ?? entry.source,
      });
    }

    if (planned.length > 0) {
      let batch: PackageBootstrapResult | undefined;
      let batchError: string | undefined;
      try {
        batch = await options.bootstrapPackages(planned.map(({ entry }) => entry.source));
        packages = batch.packages;
      } catch (error) {
        batchError = errorMessage(error);
      }
      for (const { entry, prior } of planned) {
        const result = batch?.results.find((candidate) => candidate.source === entry.source);
        const matches = matchingDescriptors(entry, packages);
        if (matches.length > 0) {
          const status = observedStatus(entry, matches, prior);
          if (result?.status === "installed" && status.observed !== "configured_broken") {
            status.provenance = "auto_managed";
          }
          statuses.set(entry.id, status);
          continue;
        }
        statuses.set(entry.id, {
          error: batchError ?? result?.error ?? "Pi did not report the package after provisioning",
          id: entry.id,
          intent: "eligible",
          observed: "missing",
          operation: "failed_retryable",
          provenance: prior?.provenance ?? "none",
          source: prior?.source ?? entry.source,
        });
      }
    }

    const entries = options.integrations.map((entry) => statuses.get(entry.id) as FoundationalPiPackageStatusEntry);
    const document = receiptWithEntries(current, entries, options.manifestRevision);
    return {
      document,
      result: {
        autoInstallNew: document.autoInstallNew,
        entries,
        state: isDegraded(entries) ? "degraded" : "ready",
      },
    };
  });
}
