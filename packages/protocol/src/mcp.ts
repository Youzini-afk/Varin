import type { PiConfigTextFormat, PiConfigTextRoot } from "./types.js";

export const PI_MCP_CONFIG_CATALOG_VERSION = 1 as const;

export type PiMcpConfigProviderState =
  | "active"
  | "degraded"
  | "incompatible"
  | "unavailable";

export interface PiMcpConfigProviderSnapshot {
  owner?: "native" | "extension";
  bridgeVersion?: number;
  issue?: string;
  state: PiMcpConfigProviderState;
}

export interface PiMcpConfigSourceTarget {
  format: PiConfigTextFormat;
  path: string;
  root: PiConfigTextRoot;
}

export interface PiMcpConfigSource {
  displayPath: string;
  id: string;
  order: number;
  scope: "project" | "user";
  serverNames: string[];
  target: PiMcpConfigSourceTarget;
}

export interface PiMcpConfigTransport {
  command?: string;
  kind: "http" | "inherited" | "socket" | "stdio";
  socket?: string;
  url?: string;
}

export interface PiMcpConfigServer {
  disabled: boolean;
  name: string;
  sourceIds: string[];
  transport: PiMcpConfigTransport;
}

export interface PiMcpConfigCatalogSnapshot {
  servers: PiMcpConfigServer[];
  sources: PiMcpConfigSource[];
  version: typeof PI_MCP_CONFIG_CATALOG_VERSION;
}

export interface PiMcpConfigSnapshot {
  catalog?: PiMcpConfigCatalogSnapshot;
  provider: PiMcpConfigProviderSnapshot;
}

export class PiMcpConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiMcpConfigValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);

const readString = (value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string => {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    throw new PiMcpConfigValidationError(`${field} must be a non-empty string`);
  }
  return value;
};

const readOptionalString = (value: unknown, field: string): string | undefined => (
  value === undefined ? undefined : readString(value, field)
);

const readStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) {
    throw new PiMcpConfigValidationError(`${field} must be an array`);
  }
  return value.map((entry, index) => readString(entry, `${field}[${index}]`));
};

const assertUnique = (values: readonly string[], field: string): void => {
  if (new Set(values).size !== values.length) {
    throw new PiMcpConfigValidationError(`${field} must not contain duplicates`);
  }
};

const parseTransport = (value: unknown, field: string): PiMcpConfigTransport => {
  if (!isRecord(value)) throw new PiMcpConfigValidationError(`${field} must be an object`);
  const kind = readString(value.kind, `${field}.kind`);
  const command = readOptionalString(value.command, `${field}.command`);
  const url = readOptionalString(value.url, `${field}.url`);
  const socket = readOptionalString(value.socket, `${field}.socket`);
  if (kind !== "stdio" && kind !== "http" && kind !== "socket" && kind !== "inherited") {
    throw new PiMcpConfigValidationError(`${field}.kind is not supported`);
  }
  if ((kind !== "stdio" && command !== undefined)
    || (kind !== "http" && url !== undefined)
    || (kind !== "socket" && socket !== undefined)) {
    throw new PiMcpConfigValidationError(`${field} contains a field from another transport`);
  }
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PiMcpConfigValidationError(`${field}.url must be an absolute URL`);
    }
    if (parsed.username || parsed.password) {
      throw new PiMcpConfigValidationError(`${field}.url must not contain user information`);
    }
    if (parsed.search || parsed.hash) {
      throw new PiMcpConfigValidationError(`${field}.url must not contain a query or fragment`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new PiMcpConfigValidationError(`${field}.url must use http or https`);
    }
  }
  return {
    ...(command === undefined ? {} : { command }),
    kind,
    ...(socket === undefined ? {} : { socket }),
    ...(url === undefined ? {} : { url }),
  };
};

const parseSource = (value: unknown, index: number): PiMcpConfigSource => {
  const field = `catalog.sources[${index}]`;
  if (!isRecord(value)) throw new PiMcpConfigValidationError(`${field} must be an object`);
  if (!Number.isSafeInteger(value.order) || (value.order as number) < 0) {
    throw new PiMcpConfigValidationError(`${field}.order must be a non-negative safe integer`);
  }
  if (value.scope !== "user" && value.scope !== "project") {
    throw new PiMcpConfigValidationError(`${field}.scope must be user or project`);
  }
  if (!isRecord(value.target)) {
    throw new PiMcpConfigValidationError(`${field}.target must be an object`);
  }
  const root = readString(value.target.root, `${field}.target.root`);
  if (root !== "agent" && root !== "home" && root !== "project" && root !== "user-config") {
    throw new PiMcpConfigValidationError(`${field}.target.root is not supported`);
  }
  const format = readString(value.target.format, `${field}.target.format`);
  if (format !== "json" && format !== "jsonc") {
    throw new PiMcpConfigValidationError(`${field}.target.format must be json or jsonc`);
  }
  const serverNames = readStringArray(value.serverNames, `${field}.serverNames`);
  assertUnique(serverNames, `${field}.serverNames`);
  return {
    displayPath: readString(value.displayPath, `${field}.displayPath`),
    id: readString(value.id, `${field}.id`),
    order: value.order as number,
    scope: value.scope,
    serverNames,
    target: {
      format,
      path: readString(value.target.path, `${field}.target.path`),
      root,
    },
  };
};

const parseServer = (value: unknown, index: number): PiMcpConfigServer => {
  const field = `catalog.servers[${index}]`;
  if (!isRecord(value)) throw new PiMcpConfigValidationError(`${field} must be an object`);
  if (typeof value.disabled !== "boolean") {
    throw new PiMcpConfigValidationError(`${field}.disabled must be a boolean`);
  }
  const sourceIds = readStringArray(value.sourceIds, `${field}.sourceIds`);
  assertUnique(sourceIds, `${field}.sourceIds`);
  return {
    disabled: value.disabled,
    name: readString(value.name, `${field}.name`),
    sourceIds,
    transport: parseTransport(value.transport, `${field}.transport`),
  };
};

/**
 * Validate the adapter-owned configCatalog/v1 projection before it crosses the
 * trusted Pi host boundary. The parser intentionally projects only documented
 * fields so credentials and future private fields cannot reach a renderer.
 */
export function parsePiMcpConfigCatalog(value: unknown): PiMcpConfigCatalogSnapshot {
  if (!isRecord(value) || value.version !== PI_MCP_CONFIG_CATALOG_VERSION) {
    throw new PiMcpConfigValidationError("catalog must use configCatalog version 1");
  }
  if (!Array.isArray(value.sources) || !Array.isArray(value.servers)) {
    throw new PiMcpConfigValidationError("catalog sources and servers must be arrays");
  }
  const sources = value.sources.map(parseSource);
  const servers = value.servers.map(parseServer);
  assertUnique(sources.map((source) => source.id), "catalog source ids");
  assertUnique(sources.map((source) => String(source.order)), "catalog source order values");
  assertUnique(servers.map((server) => server.name), "catalog server names");

  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const serversByName = new Map(servers.map((server) => [server.name, server]));
  for (const server of servers) {
    for (const sourceId of server.sourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) {
        throw new PiMcpConfigValidationError(
          `catalog server ${server.name} references unknown source ${sourceId}`,
        );
      }
      if (!source.serverNames.includes(server.name)) {
        throw new PiMcpConfigValidationError(
          `catalog source ${sourceId} does not list contributing server ${server.name}`,
        );
      }
    }
  }
  for (const source of sources) {
    for (const serverName of source.serverNames) {
      const server = serversByName.get(serverName);
      if (!server) {
        throw new PiMcpConfigValidationError(
          `catalog source ${source.id} references unknown server ${serverName}`,
        );
      }
      if (!server.sourceIds.includes(source.id)) {
        throw new PiMcpConfigValidationError(
          `catalog server ${serverName} does not list contributing source ${source.id}`,
        );
      }
    }
  }
  return {
    servers,
    sources: sources.slice().sort((left, right) => left.order - right.order),
    version: PI_MCP_CONFIG_CATALOG_VERSION,
  };
}
