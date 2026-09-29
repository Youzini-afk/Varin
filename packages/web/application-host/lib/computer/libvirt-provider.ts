/**
 * libvirt provider for BC7 — drives `virsh` against a configured connection
 * URI (`qemu:///system`, `qemu+ssh://user@host/system`, …). All domain
 * identity is keyed on the Host's durable domain UUID. A lost response is
 * reconciled with that identity; names never authorize adoption of user assets.
 */
import { HarnessServiceError } from "../harness/service-error.js";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type {
  ComputerVmProviderConfig,
  ComputerVmState,
} from "@varin/protocol";
import type {
  VmCreateOutcome,
  VmCreateSpec,
  VmExec,
  VmProvider,
  VmProviderDomain,
  VmProvisionJournalEntry,
} from "./vm-provider.js";

const STATE_MAP: Record<string, ComputerVmState> = {
  "running": "running",
  "paused": "paused",
  "shut off": "shutoff",
  "shutoff": "shutoff",
  "crashed": "crashed",
  "idle": "running",
  "in shutdown": "running",
  "pmsuspended": "paused",
};

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createLibvirtProvider(
  config: ComputerVmProviderConfig,
  exec: VmExec,
): VmProvider {
  const pool = config.storagePool?.trim() || "default";
  const network = config.network?.trim() || "default";

  const virsh = async (args: string[], expectSuccess = true, stdin?: string): Promise<string> => {
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await exec("virsh", ["-c", config.uri, ...args], stdin !== undefined ? { stdin } : undefined);
    } catch (error) {
      throw new HarnessServiceError(
        "unavailable",
        `virsh is not usable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (expectSuccess && result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `virsh exited ${result.code}`;
      throw new HarnessServiceError("unavailable", `virsh ${args[0] ?? ""} failed: ${detail}`);
    }
    return result.stdout;
  };

  const parseState = (raw: string): ComputerVmState => {
    const key = raw.trim().toLowerCase();
    return STATE_MAP[key] ?? (key ? "unknown" : "unknown");
  };

  /** Resolve a domain name to its UUID, or null when it does not exist. */
  const domainUuidFor = async (name: string): Promise<string | null> =>
    (await listDomains()).find((domain) => domain.name === name)?.domainUuid ?? null;

  const volumeNames = async (): Promise<Set<string>> => {
    const out = await virsh(["vol-list", "--pool", pool]);
    const rows = out.split(/\r?\n/);
    const separator = rows.findIndex((line) => /^\s*-+\s*$/.test(line));
    if (separator < 0) throw new HarnessServiceError("unavailable", "virsh returned an unreadable volume inventory");
    return new Set(rows.slice(separator + 1).flatMap((line) => line.trim() ? [line.trim().split(/\s+/)[0]!] : []));
  };

  const domainState = async (domainUuid: string): Promise<ComputerVmState> => {
    const out = await virsh(["domstate", domainUuid]);
    return parseState(out);
  };

  const listDomains = async (): Promise<VmProviderDomain[]> => {
    const out = await virsh(["list", "--all", "--uuid", "--name"]);
    // Columns: uuid  name — state comes from a second pass only for entries we
    // actually manage; catalog refresh calls domainState per binding instead.
    return out.split("\n").flatMap((line) => {
      const match = line.trim().match(/^([0-9a-fA-F-]{32,36})\s+(.+)$/);
      if (!match) return [];
      return [{ domainUuid: match[1]!, name: match[2]!.trim(), state: "unknown" as const }];
    });
  };

  const domainXml = (spec: VmCreateSpec, volumePath: string): string => {
    const name = xmlEscape(spec.name);
    return [
      `<domain type='kvm'>`,
      `  <name>${name}</name>`,
      `  <uuid>${spec.domainUuid}</uuid>`,
      `  <memory unit='MiB'>${spec.memoryMiB}</memory>`,
      `  <vcpu>${spec.vcpus}</vcpu>`,
      `  <os><type>hvm</type></os>`,
      `  <devices>`,
      `    <disk type='volume' device='disk'>`,
      `      <driver name='qemu' type='qcow2'/>`,
      `      <source pool='${xmlEscape(pool)}' volume='${xmlEscape(volumePath)}'/>`,
      `      <target dev='vda' bus='virtio'/>`,
      `    </disk>`,
      ...(spec.seedIsoFile ? [
        `    <disk type='volume' device='cdrom'>`,
        `      <driver name='qemu' type='raw'/>`,
        `      <source pool='${xmlEscape(pool)}' volume='${xmlEscape(`varin-${spec.domainUuid}-seed.iso`)}'/>`,
        `      <target dev='sda' bus='sata'/>`,
        `      <readonly/>`,
        `    </disk>`,
      ] : []),
      `    <interface type='network'>`,
      `      <source network='${xmlEscape(network)}'/>`,
      `      <model type='virtio'/>`,
      `    </interface>`,
      `    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>`,
      `    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>`,
      `    <video><model type='virtio' heads='1'/></video>`,
      `  </devices>`,
      `</domain>`,
    ].join("\n");
  };

  const provider: VmProvider = {
    config,

    async probe() {
      try {
        const out = await virsh(["version"]);
        const versionLine = out.split("\n").find((line) => /hypervisor/i.test(line)) ?? out.split("\n")[0];
        return { available: true, detail: versionLine?.trim() || "connected" };
      } catch (error) {
        return {
          available: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    listDomains,
    domainState,

    async stageBaseImage(input) {
      const name = `varin-${input.domainUuid}-base.qcow2`;
      const present = await volumeNames();
      if (present.has(name) && !input.volumePaths.includes(name)) {
        throw new HarnessServiceError("unavailable", "Cloud image volume exists without this creation's allocation receipt");
      }
      if (!present.has(name)) {
        const bytes = (await stat(input.file)).size;
        if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new HarnessServiceError("unavailable", "Cloud image file is empty or unreadable");
        const file = await open(input.file, "r");
        const header = Buffer.alloc(32);
        try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
        if (header.toString("ascii", 0, 3) !== "QFI" || header[3] !== 0xfb || header.readBigUInt64BE(24) <= 0n) {
          throw new HarnessServiceError("unavailable", "Verified Debian image is not a valid qcow2 volume");
        }
        await virsh(["vol-create-as", pool, name, `${header.readBigUInt64BE(24)}B`, "--format", "qcow2"]);
        await input.checkpoint(input.volumePaths.includes(name) ? [...input.volumePaths] : [...input.volumePaths, name]);
      }
      if (!input.uploaded || !present.has(name)) {
        await virsh(["vol-upload", name, input.file, "--pool", pool]);
      }
      return name;
    },

    async upgradeSeed(input) {
      const seedName = `varin-${input.domainUuid}-seed.iso`;
      if (!input.volumePaths.includes(seedName) || !(await volumeNames()).has(seedName)) {
        throw new HarnessServiceError("unavailable", "This VM has no recorded managed guest seed volume");
      }
      const state = await domainState(input.domainUuid);
      if (state !== "shutoff") throw new HarnessServiceError("invalid-params", "Shut down the VM before upgrading its guest runtime");
      const bytes = (await stat(input.isoFile)).size;
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new HarnessServiceError("unavailable", "New guest seed ISO is empty or unreadable");
      const info = await virsh(["vol-info", seedName, "--pool", pool, "--bytes"]);
      const capacity = info.match(/^Capacity:\s*(\d+)/imu)?.[1];
      if (!capacity) throw new HarnessServiceError("unavailable", "Managed guest seed capacity could not be read");
      if (BigInt(capacity) < BigInt(bytes)) await virsh(["vol-resize", seedName, `${bytes}B`, "--pool", pool]);
      // Repeating an interrupted upload writes the same verified ISO to the
      // same UUID-owned volume. The VM remains shut off until it succeeds.
      await virsh(["vol-upload", seedName, input.isoFile, "--pool", pool]);
    },

    async create(spec: VmCreateSpec): Promise<VmCreateOutcome> {
      if (!namePattern.test(spec.name)) {
        throw new HarnessServiceError(
          "invalid-params",
          `VM name must match ${namePattern} (got ${JSON.stringify(spec.name)})`,
        );
      }
      const steps: VmProvisionJournalEntry[] = [];
      const step = (entry: VmProvisionJournalEntry) => steps.push(entry);
      if (![spec.memoryMiB, spec.vcpus, spec.diskGiB].every((value) => Number.isSafeInteger(value) && value > 0)) {
        throw new HarnessServiceError("invalid-params", "VM memory, vCPUs and disk size must be positive integers");
      }
      const domainUuid = spec.domainUuid ?? randomUUID();
      const volumeName = `varin-${domainUuid}.qcow2`;
      const seedName = `varin-${domainUuid}-seed.iso`;
      const baseName = `varin-${domainUuid}-base.qcow2`;
      let volumePaths = [...(spec.volumePaths ?? [])];
      const checkpoint = async () => spec.checkpoint?.({ ok: false, domainUuid, volumePaths: [...volumePaths], steps: [...steps] });
      let existing: string | null;
      try { existing = await domainUuidFor(spec.name); }
      catch (error) { return { ok: false, domainUuid, volumePaths, steps, error: String(error) }; }
      if (existing) {
        if (existing !== domainUuid) throw new HarnessServiceError("invalid-params", "A different domain already has this name; it is not owned by this creation request");
        step({ step: "resolve", status: "done", detail: `existing domain ${existing}` });
        return { ok: true, domainUuid: existing, volumePaths, steps, adopted: true };
      }
      step({ step: "resolve", status: "done", detail: "no existing domain" });
      try {
        const existingVolumes = await volumeNames();
        if (existingVolumes.has(volumeName)) {
          if (!volumePaths.includes(volumeName)) throw new Error("The creation volume exists without a confirmed allocation receipt; it was retained for inspection");
        } else if (spec.baseImage) {
          // Clone the prepared base image so user data never lands on it.
          await virsh(["vol-clone", spec.baseImage, volumeName, "--pool", pool]);
          step({ step: "volume", status: "done", detail: `${pool}/${volumeName} cloned from ${spec.baseImage}` });
        } else {
          await virsh([
            "vol-create-as", pool, volumeName, `${spec.diskGiB}G`,
            "--format", "qcow2",
          ]);
        }
        volumePaths = [volumeName, ...volumePaths.filter((volume) => volume === seedName || volume === baseName)];
        step({ step: "volume", status: "done", detail: `${pool}/${volumeName}` });
        await checkpoint();
        if (spec.baseImage) {
          const info = await virsh(["vol-info", volumeName, "--pool", pool, "--bytes"]);
          const capacity = info.match(/^Capacity:\s*(\d+)/imu)?.[1];
          if (!capacity) throw new Error("Cloned cloud disk capacity could not be read");
          if (BigInt(capacity) < BigInt(spec.diskGiB) * 1024n * 1024n * 1024n) {
            await virsh(["vol-resize", volumeName, `${spec.diskGiB}G`, "--pool", pool]);
          }
          step({ step: "disk-size", status: "done", detail: `at least ${spec.diskGiB} GiB` });
          await checkpoint();
        }
        if (spec.seedIsoFile) {
          const seedBytes = (await stat(spec.seedIsoFile)).size;
          if (!Number.isSafeInteger(seedBytes) || seedBytes <= 0) throw new Error("NoCloud seed ISO is empty or unreadable");
          const present = await volumeNames();
          if (present.has(seedName)) {
            if (!volumePaths.includes(seedName)) throw new Error("NoCloud seed volume exists without an allocation receipt; retained for inspection");
          } else {
            await virsh(["vol-create-as", pool, seedName, `${seedBytes}B`, "--format", "raw"]);
            volumePaths.push(seedName);
            step({ step: "seed-volume", status: "done", detail: `${pool}/${seedName}` });
            await checkpoint();
          }
          // An interrupted upload is safely resumed into the same owned seed.
          await virsh(["vol-upload", seedName, spec.seedIsoFile, "--pool", pool]);
          step({ step: "seed-upload", status: "done", detail: `${seedBytes} bytes` });
          await checkpoint();
        }
      } catch (error) {
        step({
          step: "volume",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        // A failed command/response is not proof of allocation ownership. Never
        // delete a possibly pre-existing volume to clean up an uncertain call.
        return { ok: false, domainUuid, volumePaths, steps, error: `VM create failed at volume: ${steps.find((entry) => entry.step === "volume" && entry.status === "failed")?.detail}` };
      }

      // Domain XML rides stdin via virsh's `/dev/stdin` convention — no
      // host-side temp file is needed.
      let defined = false;
      try {
        await virsh(["define", "/dev/stdin"], true, domainXml({ ...spec, domainUuid }, volumeName));
        defined = true;
      } catch (error) {
        step({
          step: "define",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (!defined) {
        // A lost define response may have created the domain. Reconcile its
        // fixed UUID; preserve the allocation on failed/unknown observation.
        try {
          defined = (await domainUuidFor(spec.name)) === domainUuid;
        } catch { /* retain unknown resources */ }
        if (!defined) return { ok: false, domainUuid, volumePaths, steps, error: `VM create failed at define; allocated disk retained: ${steps.find((entry) => entry.status === "failed")?.detail}` };
      }
      let uuid: string | null = null;
      try { uuid = await domainUuidFor(spec.name); } catch { /* preserve journal */ }
      if (uuid !== domainUuid) {
        // The domain may be defined — its disk is NOT garbage. Report the
        // ambiguity honestly; the next create will adopt by name.
        step({
          step: "define",
          status: "failed",
          detail: "define returned but domuuid lookup failed — domain may exist; volume retained",
        });
        return { ok: false, domainUuid, volumePaths, steps, error: "VM create failed at define: UUID unresolved" };
      }
      step({ step: "define", status: "done", detail: uuid });
      return { ok: true, domainUuid: uuid, volumePaths, steps };
    },

    async start(domainUuid: string) {
      await virsh(["start", domainUuid]);
    },

    async shutdown(domainUuid: string) {
      // ACPI request — a guest without acpi/agent support ignores it; the
      // reported state stays honest because callers re-read domainState.
      await virsh(["shutdown", domainUuid]);
    },

    async reboot(domainUuid: string) {
      const state = await domainState(domainUuid);
      if (state === "shutoff") {
        // `virsh reboot` fails on a shutoff domain; the honest equivalent is
        // start — callers asked for "running again", not a noop error.
        await virsh(["start", domainUuid]);
        return;
      }
      await virsh(["reboot", domainUuid]);
    },

    async delete(domainUuid: string, volumePaths: string[], deleteDisks: boolean) {
      if (deleteDisks && volumePaths.some((volume) => volume !== `varin-${domainUuid}.qcow2`
        && volume !== `varin-${domainUuid}-seed.iso` && volume !== `varin-${domainUuid}-base.qcow2`)) {
        throw new HarnessServiceError("invalid-params", "Disk deletion requires this creation's recorded allocation identity");
      }
      if ((await listDomains()).some((domain) => domain.domainUuid === domainUuid)) {
        const state = await domainState(domainUuid);
        if (state === "unknown") throw new HarnessServiceError("unavailable", "Cannot delete a domain whose state is unknown");
        if (state === "running" || state === "paused") await virsh(["destroy", domainUuid]);
        await virsh(["undefine", domainUuid]);
      }
      if (deleteDisks) {
        const remaining = await volumeNames();
        for (const volumePath of volumePaths) {
          // Strict: a failed disk removal must surface, not masquerade as a
          // complete delete — the caller can retry with the same record.
          if (remaining.has(volumePath)) await virsh(["vol-delete", "--pool", pool, volumePath]);
        }
      }
    },
  };
  return provider;
}
