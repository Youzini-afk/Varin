import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { FileAuthStorageBackend, loadMcpConfig, McpOAuthCredentialStore,
  type McpExtensionOptions, type McpStateSnapshot } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { ConfigTextFileEditor, resolveConfigDocumentPath } from "./config-text-file-editor.js";
import {
  parsePiMcpConfigCatalog,
  type HostEvent, type HostEventData, type PiMcpConfigSource,
  type PiMcpConfigSnapshot,
} from "@varin/protocol";

export const PI_MCP_RPC_VERSION = 1 as const;
export const PI_MCP_RPC_READY_EVENT = "pi-mcp-adapter:rpc:v1:ready";
export const PI_MCP_RPC_REQUEST_EVENT = "pi-mcp-adapter:rpc:v1:request";
export const PI_MCP_RPC_REPLY_PREFIX = "pi-mcp-adapter:rpc:v1:reply:";
export const MCP_STATUS_CHANNEL = "varin.mcp/status/v1";

type ExtensionEventBus = ExtensionAPI["events"];

interface CompatibleReadyState {
  compatible: true;
  version: number;
}

interface IncompatibleReadyState {
  compatible: false;
  issue: string;
  version?: number;
}

type ReadyState = CompatibleReadyState | IncompatibleReadyState;

interface PendingRequest {
  reject(error: Error): void;
  unsubscribe?: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);

const parseReady = (value: unknown, sessionId: string, cwd: string): ReadyState => {
  if (!isRecord(value)) {
    return { compatible: false, issue: "pi-mcp-adapter returned an invalid RPC ready payload" };
  }
  const version = typeof value.version === "number" ? value.version : undefined;
  if (version !== PI_MCP_RPC_VERSION) {
    return {
      compatible: false,
      ...(version === undefined ? {} : { version }),
      issue: version === undefined
        ? "pi-mcp-adapter did not report an RPC version"
        : `pi-mcp-adapter RPC v${version} is not supported`,
    };
  }
  if (!Array.isArray(value.methods) || !value.methods.includes("config.snapshot")) {
    return { compatible: false, issue: "pi-mcp-adapter RPC does not advertise config.snapshot", version };
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const catalog = capabilities && isRecord(capabilities.configCatalog)
    ? capabilities.configCatalog
    : undefined;
  if (catalog?.version !== 1 || catalog.readOnly !== true) {
    return {
      compatible: false,
      issue: "pi-mcp-adapter does not advertise read-only configCatalog v1",
      version,
    };
  }
  const session = isRecord(value.session) ? value.session : undefined;
  if (session?.sessionId !== sessionId || session.cwd !== cwd) {
    return {
      compatible: false,
      issue: "pi-mcp-adapter RPC ready state belongs to a different session or workspace",
      version,
    };
  }
  return { compatible: true, version };
};

const unavailable = (issue: string): PiMcpConfigSnapshot => ({
  provider: { issue, state: "unavailable" },
});

const incompatible = (ready: IncompatibleReadyState): PiMcpConfigSnapshot => ({
  provider: {
    ...(ready.version === undefined ? {} : { bridgeVersion: ready.version }),
    issue: ready.issue,
    state: "incompatible",
  },
});

const parseReply = (
  value: unknown,
  requestId: string,
  bridgeVersion: number,
  sessionId: string,
  cwd: string,
): PiMcpConfigSnapshot => {
  if (!isRecord(value) || value.version !== PI_MCP_RPC_VERSION || value.requestId !== requestId) {
    throw new Error("pi-mcp-adapter returned an invalid config snapshot reply envelope");
  }
  const session = isRecord(value.session) ? value.session : undefined;
  if (session?.sessionId !== sessionId || session.cwd !== cwd) {
    throw new Error("pi-mcp-adapter returned a config snapshot for a different session or workspace");
  }
  if (value.success === false && isRecord(value.error)) {
    const code = typeof value.error.code === "string" ? value.error.code : "rpc_failed";
    const message = typeof value.error.message === "string"
      ? value.error.message
      : "pi-mcp-adapter config snapshot failed";
    throw new Error(`${code}: ${message}`);
  }
  if (value.success !== true || !isRecord(value.data)) {
    throw new Error("pi-mcp-adapter returned an invalid config snapshot reply");
  }
  return {
    catalog: parsePiMcpConfigCatalog(value.data.catalog),
    provider: { owner: "extension", bridgeVersion, state: "active" },
  };
};

/**
 * Session-owned observation of native MCP or a user's replacement extension.
 * Native options and the extension's public RPC contract stay here; neither
 * path creates another MCP connection or credential authority.
 */
export class PiMcpConfigBridge {
  #cwd: string | undefined;
  #events: ExtensionEventBus | undefined;
  #generation = 0;
  #nextRequestId = 0;
  #pending = new Map<string, PendingRequest>();
  #pendingReady: unknown;
  #ready: ReadyState | undefined;
  #sessionId: string | undefined;
  #native: { state: McpStateSnapshot; snapshot: PiMcpConfigSnapshot } | undefined;

  /** Observe the native owner; no additional MCP clients or connection state. */
  nativeOptions(agentDir: string, emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => void): McpExtensionOptions {
    let sources: PiMcpConfigSource[] = [];
    return {
      credentials: new McpOAuthCredentialStore(new FileAuthStorageBackend(join(agentDir, "mcp-auth.json")), agentDir),
      logPath: join(agentDir, "mcp.log"),
      updateConfig: async (entry, patch) => {
        const source = sources.find(candidate => candidate.displayPath === (entry.override ?? entry.source));
        if (!source) throw new Error("MCP configuration source is no longer active");
        const location = await resolveConfigDocumentPath(source.scope === "user" ? agentDir : this.#cwd!, source.target.path, { extensions: [".json"] });
        const editor = new ConfigTextFileEditor(location.path, "json");
        const current = await editor.read();
        let content = current.content;
        for (const [key, value] of Object.entries(patch)) {
          content = applyEdits(content, modify(content, ["mcpServers", entry.name, key],
            !entry.override && (key === "enabled" && value === true || key === "exposure" && value === "codemode") ? undefined : value,
            { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
        }
        await editor.update(content, current.revision);
      },
      loadConfig: ctx => {
        const globalConfig = loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: false });
        const loaded = ctx.isProjectTrusted()
          ? loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: true }) : globalConfig;
        sources = [
          { id: "native:user", displayPath: join(agentDir, "mcp.json"), order: 0, scope: "user",
            serverNames: globalConfig.servers.map(entry => entry.name), target: { root: "agent", path: "mcp.json", format: "json" } },
          { id: "native:project", displayPath: join(ctx.cwd, ".pi", "mcp.json"), order: 1, scope: "project",
            serverNames: loaded.servers.filter(entry => entry.scope === "project" || entry.override !== undefined).map(entry => entry.name),
            target: { root: "project", path: ".pi/mcp.json", format: "json" } },
        ];
        return loaded;
      },
      onState: state => {
        if (!state.active) {
          this.#native = undefined;
          emit("extension.state", { channel: MCP_STATUS_CHANNEL, sessionId: state.sessionId, value: null });
          return;
        }
        const catalog = parsePiMcpConfigCatalog({ version: 1, sources, servers: state.servers.map(server => ({
          disabled: server.disabled, name: server.name, transport: server.transport,
          sourceIds: sources.filter(source => source.serverNames.includes(server.name)).map(source => source.id),
        })) });
        this.#native = { state, snapshot: { catalog, provider: { owner: "native",
          state: state.configErrorCount ? "degraded" : "active",
          ...(state.configErrorCount ? { issue: `${state.configErrorCount} MCP configuration error(s); inspect mcp.json` } : {}),
        } } };
        const servers = state.servers.map(server => ({ name: server.name, disabled: server.disabled,
          toolCount: server.toolCount, resourceCount: server.resourceCount,
          status: server.status === "disconnected" || server.status === "closed" || server.status === "connecting"
            ? "not-connected" : server.status,
        }));
        emit("extension.state", { channel: MCP_STATUS_CHANNEL, sessionId: state.sessionId, value: {
          version: 1, owner: "native", servers,
          connectedCount: servers.filter(server => server.status === "connected").length,
          disabledCount: servers.filter(server => server.disabled).length,
          totalTools: servers.reduce((sum, server) => sum + server.toolCount, 0),
          totalResources: servers.reduce((sum, server) => sum + server.resourceCount, 0),
        } });
      },
    };
  }

  attach(events: ExtensionEventBus): () => void {
    this.#events = events;
    const unsubscribe = events.on(PI_MCP_RPC_READY_EVENT, (value) => {
      if (!this.#sessionId || !this.#cwd) {
        this.#pendingReady = value;
        return;
      }
      this.#ready = parseReady(value, this.#sessionId, this.#cwd);
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      this.#endSession("Pi MCP config bridge was disposed");
      this.#events = undefined;
    };
  }

  startSession(sessionId: string, cwd: string): void {
    const pendingReady = this.#pendingReady;
    const native = this.#native;
    this.#endSession("Pi session changed while reading MCP configuration");
    this.#sessionId = sessionId;
    this.#cwd = cwd;
    if (native?.state.sessionId === sessionId && native.state.cwd === cwd) this.#native = native;
    if (pendingReady !== undefined) this.#ready = parseReady(pendingReady, sessionId, cwd);
  }

  endSession(): void {
    this.#endSession("Pi session closed while reading MCP configuration");
  }

  async snapshot(sessionId: string): Promise<PiMcpConfigSnapshot> {
    if (this.#sessionId !== sessionId || !this.#events) {
      return unavailable("Open a Pi session or workspace context to inspect MCP configuration");
    }
    if (this.#native?.state.sessionId === sessionId && this.#native.state.cwd === this.#cwd) return this.#native.snapshot;
    if (!this.#ready) {
      return unavailable("No native MCP or replacement extension config catalog is active in this session");
    }
    if (!this.#ready.compatible) return incompatible(this.#ready);
    const bridgeVersion = this.#ready.version;
    try {
      const requestId = await this.#requestSnapshot(sessionId);
      return parseReply(requestId.reply, requestId.id, bridgeVersion, sessionId, this.#cwd!);
    } catch (error) {
      return {
        provider: {
          bridgeVersion,
          issue: error instanceof Error ? error.message : String(error),
          state: "degraded",
        },
      };
    }
  }

  #requestSnapshot(sessionId: string): Promise<{ id: string; reply: unknown }> {
    const events = this.#events;
    if (!events || this.#sessionId !== sessionId) {
      throw new Error("Pi MCP config bridge is unavailable");
    }
    const generation = this.#generation;
    const requestId = `varin-mcp-config-${generation}-${++this.#nextRequestId}`;
    const replyEvent = `${PI_MCP_RPC_REPLY_PREFIX}${requestId}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.#pending.get(requestId);
        this.#pending.delete(requestId);
        pending?.unsubscribe?.();
      };
      const unsubscribe = events.on(replyEvent, (reply) => {
        cleanup();
        if (generation !== this.#generation || this.#sessionId !== sessionId) {
          reject(new Error("Pi session changed while reading MCP configuration"));
          return;
        }
        resolve({ id: requestId, reply });
      });
      this.#pending.set(requestId, {
        reject,
        ...(typeof unsubscribe === "function" ? { unsubscribe } : {}),
      });
      try {
        events.emit(PI_MCP_RPC_REQUEST_EVENT, {
          method: "config.snapshot",
          params: {},
          requestId,
          session: { cwd: this.#cwd, sessionId },
          source: { extension: "varin" },
          version: PI_MCP_RPC_VERSION,
        });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // config.snapshot/v1 is deliberately synchronous: the adapter builds it
      // from its synchronous native config loader during event dispatch. If a
      // compatible provider returns from emit without replying, no later work
      // exists that can complete this request. Reject now so the host's serial
      // request queue remains available to package and config operations.
      if (this.#pending.has(requestId)) {
        cleanup();
        reject(new Error("pi-mcp-adapter did not reply to config.snapshot during event dispatch"));
      }
    });
  }

  #endSession(message: string): void {
    this.#native = undefined;
    this.#generation += 1;
    this.#cwd = undefined;
    this.#ready = undefined;
    this.#pendingReady = undefined;
    this.#sessionId = undefined;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.unsubscribe?.();
      request.reject(new Error(message));
    }
  }
}

export function createPiMcpConfigBridgeExtension(bridge: PiMcpConfigBridge): ExtensionFactory {
  return (pi) => {
    const detach = bridge.attach(pi.events);
    pi.on("session_start", (_event, context: ExtensionContext) => {
      bridge.startSession(context.sessionManager.getSessionId(), context.cwd);
    });
    pi.on("session_shutdown", () => {
      bridge.endSession();
      detach();
    });
  };
}
