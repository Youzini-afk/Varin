import { execFile } from "node:child_process";

/** A GPU identity and the facts returned by the host probe. */
export interface GpuDeviceFact {
  /** Host-visible ordinal, useful for diagnostics only. */
  index: number;
  /** Stable NVIDIA identity used for commitments and CUDA binding. */
  uuid: string;
  name?: string;
  memoryMb?: number;
  usedMemoryMb?: number;
  utilizationPercent?: number;
}

export type GpuProbeResult =
  | { status: "available"; devices: GpuDeviceFact[] }
  | { status: "unavailable"; reason: "tool-missing" | "no-device" | "error"; detail?: string };

export interface GpuAllocationDevice {
  index: number;
  uuid: string;
  name?: string;
  memoryMb?: number;
}

/** Durable resource binding returned by admission and consumed by the spawn target. */
export interface GpuAllocation {
  devices: GpuAllocationDevice[];
  environment: { name: "CUDA_VISIBLE_DEVICES"; value: string };
}

export interface GpuReservation {
  /** The requested count is retained for validating old/incomplete records. */
  gpuCount?: number;
  allocation?: GpuAllocation;
}

export type GpuAllocationResult =
  | { status: "confirmed"; allocation: GpuAllocation }
  | { status: "insufficient"; reason: string };

const NVIDIA_SMI = "nvidia-smi";
const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu",
  "--format=csv,noheader,nounits",
] as const;

const finiteNonNegative = (value: string): number | undefined => {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const optionalFact = (value: string): number | undefined => (
  /^(?:n\/a|na|unknown|-)$/i.test(value.trim()) ? undefined : finiteNonNegative(value)
);

const parseIndex = (value: string): number | undefined => {
  const parsed = finiteNonNegative(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
};

/**
 * Parse the fixed nvidia-smi CSV query. Malformed rows are ignored so one
 * unreadable device does not turn an otherwise useful inventory into a fake
 * zero-device result; callers classify an entirely malformed response as an
 * error.
 */
export const parseNvidiaSmiCsv = (output: string): GpuDeviceFact[] => {
  const devices: GpuDeviceFact[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = line.split(",").map((entry) => entry.trim());
    if (columns.length < NVIDIA_SMI_ARGS[0].split(",").length) continue;
    const index = parseIndex(columns[0] ?? "");
    const uuid = columns[1]?.trim();
    if (index === undefined || !uuid || !/^GPU-[^\s,]+$/i.test(uuid) || seen.has(uuid)) continue;
    const name = columns[2]?.trim();
    const memoryMb = optionalFact(columns[3] ?? "");
    const usedMemoryMb = optionalFact(columns[4] ?? "");
    const utilizationPercent = optionalFact(columns[5] ?? "");
    if (utilizationPercent !== undefined && utilizationPercent > 100) continue;
    seen.add(uuid);
    devices.push({
      index,
      uuid,
      ...(name && !/^(?:n\/a|unknown|-)$/i.test(name) ? { name } : {}),
      ...(memoryMb === undefined ? {} : { memoryMb }),
      ...(usedMemoryMb === undefined ? {} : { usedMemoryMb }),
      ...(utilizationPercent === undefined ? {} : { utilizationPercent }),
    });
  }
  return devices.sort((left, right) => left.index - right.index || left.uuid.localeCompare(right.uuid));
};

const errorText = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
};

/**
 * Probe the host using one fixed, non-shell nvidia-smi invocation. No command
 * is accepted from callers and no sampling daemon is created.
 */
export const probeNvidiaSmi = (signal?: AbortSignal): Promise<GpuProbeResult> => new Promise((resolve) => {
  if (signal?.aborted) { resolve({ status: 'unavailable', reason: 'error', detail: 'GPU probe cancelled' }); return; }
  let closed = false;
  let result: GpuProbeResult | undefined;
  const finish = (value: GpuProbeResult) => { result = value; if (closed) resolve(value); };
  const child = execFile(
    NVIDIA_SMI,
    [...NVIDIA_SMI_ARGS],
    { windowsHide: true, encoding: "utf8" },
    (error, stdout, stderr) => {
      const output = typeof stdout === "string" ? stdout : "";
      const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim() : undefined;
      const devices = parseNvidiaSmiCsv(output);
      if (!error && devices.length > 0) {
        finish({ status: "available", devices });
        return;
      }
      if (!error && !output.trim()) {
        finish({ status: "unavailable", reason: "no-device", ...(detail ? { detail } : {}) });
        return;
      }
      const outputDetail = `${output}${detail ? ` ${detail}` : ""}`;
      if (/no devices? (?:were )?found|no cuda-capable device/i.test(outputDetail)) {
        finish({ status: "unavailable", reason: "no-device", detail: outputDetail.trim() });
        return;
      }
      if (!error && output.trim() && devices.length === 0) {
        finish({ status: "unavailable", reason: "error", detail: detail ?? "nvidia-smi returned no parseable GPU rows" });
        return;
      }
      const message = `${errorText(error)}${detail ? `: ${detail}` : ""}`;
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        finish({ status: "unavailable", reason: "tool-missing", detail: message });
        return;
      }
      if (/no devices? (were )?found|no cuda-capable device|not found/i.test(message)) {
        finish({ status: "unavailable", reason: "no-device", detail: message });
        return;
      }
      finish({ status: "unavailable", reason: "error", detail: message });
    },
  );
  const abort = () => { child.kill('SIGKILL'); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.once('close', () => {
    closed = true; signal?.removeEventListener('abort', abort);
    if (signal?.aborted) resolve({ status: 'unavailable', reason: 'error', detail: signal.reason instanceof Error ? signal.reason.message : 'GPU probe cancelled' });
    else if (result) resolve(result);
  });
});

const allocationDevices = (reservation: GpuReservation): GpuAllocationDevice[] => (
  reservation.allocation?.devices ?? []
);

/**
 * Select concrete uncommitted devices for one request. A commitment without a
 * durable allocation cannot be reconciled safely and blocks further GPU
 * admission until the target reports the actual binding.
 */
export const allocateGpuDevices = (
  devices: GpuDeviceFact[],
  reservations: GpuReservation[],
  request: { gpuCount?: number; gpuMemoryMb?: number },
): GpuAllocationResult => {
  const gpuCount = request.gpuCount && request.gpuCount > 0 ? request.gpuCount : undefined;
  const gpuMemoryMb = request.gpuMemoryMb && request.gpuMemoryMb > 0 ? request.gpuMemoryMb : undefined;
  if (gpuCount === undefined && gpuMemoryMb === undefined) {
    return { status: "confirmed", allocation: { devices: [], environment: { name: "CUDA_VISIBLE_DEVICES", value: "" } } };
  }
  if (devices.length === 0) return { status: "insufficient", reason: "GPU inventory is unavailable" };
  if (devices.some((device) => !device.uuid)) return { status: "insufficient", reason: "GPU identity is unavailable; resource commitments require reconciliation" };
  if (new Set(devices.map((device) => device.uuid)).size !== devices.length) {
    return { status: "insufficient", reason: "GPU inventory contains duplicate device identities" };
  }
  for (const reservation of reservations) {
    const requested = reservation.gpuCount && reservation.gpuCount > 0 ? reservation.gpuCount : 0;
    if (requested > 0 && allocationDevices(reservation).length !== requested) {
      return { status: "insufficient", reason: "an active GPU commitment has no confirmed device allocation; resource reconciliation is required" };
    }
  }
  const inventoryIds = new Set(devices.map((device) => device.uuid));
  for (const reservation of reservations) {
    if (allocationDevices(reservation).some((device) => !inventoryIds.has(device.uuid))) {
      return { status: "insufficient", reason: "an active GPU commitment references a device missing from the current inventory; resource reconciliation is required" };
    }
  }
  const committed = new Set(reservations.flatMap((reservation) => allocationDevices(reservation).map((device) => device.uuid)));
  const candidates = devices
    .filter((device) => !committed.has(device.uuid))
    .map((device) => ({
      device,
      memory: device.memoryMb,
      availableMemory: device.memoryMb === undefined || device.usedMemoryMb === undefined
        ? undefined
        : Math.max(0, device.memoryMb - device.usedMemoryMb),
    }));
  if (gpuCount !== undefined && candidates.length < gpuCount) {
    return { status: "insufficient", reason: `insufficient uncommitted GPU devices (need ${gpuCount})` };
  }

  // Prefer the largest devices so a memory request is checked against the
  // actual selected set. Known free memory is preferred; unknown usage sorts
  // last and is never treated as zero.
  const byMemory = [...candidates].sort((left, right) => (
    (right.availableMemory ?? -1) - (left.availableMemory ?? -1)
      || (right.memory ?? -1) - (left.memory ?? -1)
      || left.device.index - right.device.index
  ));
  let selected: typeof candidates;
  if (gpuCount !== undefined) {
    selected = byMemory.slice(0, gpuCount);
  } else {
    selected = [];
    let total = 0;
    for (const candidate of byMemory) {
      selected.push(candidate);
      if (candidate.availableMemory === undefined) {
        return { status: "insufficient", reason: "GPU available memory is unknown for the requested allocation" };
      }
      total += candidate.availableMemory;
      if (total >= gpuMemoryMb!) break;
    }
  }
  if (selected.length === 0) return { status: "insufficient", reason: "no GPU device satisfies the request" };
  if (gpuMemoryMb !== undefined) {
    if (selected.some((candidate) => candidate.availableMemory === undefined)) {
      return { status: "insufficient", reason: "GPU available memory is unknown for the requested allocation" };
    }
    const total = selected.reduce((sum, candidate) => sum + candidate.availableMemory!, 0);
    if (total < gpuMemoryMb) return { status: "insufficient", reason: `insufficient available GPU memory on selected devices (need ${gpuMemoryMb} MiB)` };
  }
  const selectedDevices = selected.map(({ device }) => ({
    index: device.index,
    uuid: device.uuid,
    ...(device.name ? { name: device.name } : {}),
    ...(device.memoryMb === undefined ? {} : { memoryMb: device.memoryMb }),
  })).sort((left, right) => left.index - right.index || left.uuid.localeCompare(right.uuid));
  return {
    status: "confirmed",
    allocation: {
      devices: selectedDevices,
      environment: {
        name: "CUDA_VISIBLE_DEVICES",
        value: selectedDevices.map((device) => device.uuid).join(","),
      },
    },
  };
};
