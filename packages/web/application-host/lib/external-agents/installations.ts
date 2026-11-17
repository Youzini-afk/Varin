import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
  realpath,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline, finished } from "node:stream/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { x as extractTar } from "tar";
import {
  ExternalAgentError,
  type ExternalAgentConfiguration,
  type ExternalAgentSettings,
  type ExternalAgentInstallation,
  type ExternalAgentInstallations,
  type ExternalAgentInstallationRequest,
} from "@varin/application-client";
import type { createKernelProcessService } from "../kernel/process-service.js";
import { getExternalAgentProfile } from "./profiles.js";
import { assertProfilePlatform } from "./profile-launch.js";
import { ManagedProcessLaunchError } from "../process/types.js";

type Launch = { command: string; args: string[]; env: NodeJS.ProcessEnv };
export type ExternalAgentDownload = (
  url: string,
  init?: RequestInit & { dispatcher?: never },
) => Promise<Response>;
type Manifest = { version: string; profileId: string; command: string };
type Job = {
  state: ExternalAgentInstallation;
  controller: AbortController;
  work: Promise<void>;
  log: string;
};
interface Dependencies {
  directory: string;
  spawn: ReturnType<typeof createKernelProcessService>["spawn"];
  fetch: ExternalAgentDownload;
  settings(): Promise<ExternalAgentSettings>;
  configure(
    value: Pick<ExternalAgentSettings, "agents" | "defaultAgent">,
    revision: number,
    key: string,
  ): Promise<unknown>;
  executable(config: ExternalAgentConfiguration): Promise<Launch>;
  /** Original process owner must join users before their installation is removed. */
  removeProgram(directory: string): Promise<void>;
}

function childPath(root: string, relative: string) {
  const target = path.resolve(root, relative.replaceAll("\\", "/"));
  const suffix = path.relative(root, target);
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${path.sep}`) ||
    path.isAbsolute(suffix)
  )
    throw new Error(`Installation path escapes its directory: ${relative}`);
  return target;
}

/** One owner per execution Host. Jobs continue when a settings view disconnects.
 * Catalog configuration selects the active immutable generation; there is no second active pointer. */
export class ExternalAgentInstaller {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<() => void>();
  private readonly epoch = randomUUID();
  private revision = 0;
  private closing = false;
  constructor(private readonly deps: Dependencies) {}
  private root(id: string) {
    return path.join(
      this.deps.directory,
      "programs",
      createHash("sha256").update(id).digest("hex"),
    );
  }
  private changed() {
    this.revision++;
    for (const wake of [...this.listeners]) wake();
  }
  private snapshot(): ExternalAgentInstallations {
    return {
      revision: `${this.epoch}:${this.revision}`,
      operations: [...this.jobs.values()].map((job) => ({ ...job.state })),
    };
  }
  async inspect(
    config: ExternalAgentConfiguration,
  ): Promise<{ directory: string; version: string } | undefined> {
    const root = this.root(config.id);
    const relative = path.relative(root, config.command);
    if (
      path.isAbsolute(relative) ||
      relative.startsWith("..") ||
      !relative.includes(path.sep)
    )
      return;
    const directory = childPath(root, relative.split(path.sep)[0]!);
    try {
      const manifest: Manifest = JSON.parse(
        await readFile(
          path.join(directory, ".varin-installation.json"),
          "utf8",
        ),
      );
      if (
        childPath(directory, manifest.command) !== path.resolve(config.command)
      )
        return;
      return { directory, version: manifest.version };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async log(id: string) {
    return this.jobs.get(id)?.log ?? "";
  }
  async request(
    input: ExternalAgentInstallationRequest,
    signal?: AbortSignal,
  ): Promise<ExternalAgentInstallations> {
    if (input.action === "watch") {
      if (input.after === this.snapshot().revision)
        await new Promise<void>((resolve, reject) => {
          const clean = () => {
            this.listeners.delete(wake);
            signal?.removeEventListener("abort", abort);
          };
          const wake = () => {
            clean();
            resolve();
          };
          const abort = () => {
            clean();
            reject(signal?.reason);
          };
          this.listeners.add(wake);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
    } else if (input.action !== "state") {
      if (typeof input.id !== "string" || !input.id.trim())
        throw new ExternalAgentError(
          "invalid_request",
          "A configuration is required",
        );
      const previous = this.jobs.get(input.id);
      if (input.action === "cancel") {
        if (
          previous?.state.status === "running" &&
          !["activating", "removing"].includes(previous.state.stage)
        ) {
          previous.state.status = "cancelling";
          previous.controller.abort();
          this.changed();
        }
      } else {
        if (this.closing)
          throw new ExternalAgentError("host_stopping", "Host is stopping");
        if (
          previous &&
          ["running", "cancelling"].includes(previous.state.status)
        )
          return this.snapshot();
        if (!["install", "check", "uninstall"].includes(input.action))
          throw new ExternalAgentError(
            "invalid_request",
            "Unknown installation action",
          );
        const config = (await this.deps.settings()).agents.find(
          (agent) => agent.id === input.id,
        );
        if (!config)
          throw new ExternalAgentError(
            "agent_missing",
            "External Agent configuration is unavailable",
          );
        // Recheck after the settings read so simultaneous clients share one operation.
        if (this.jobs.get(input.id) !== previous) return this.snapshot();
        const job: Job = {
          state: {
            configurationId: input.id,
            operation: input.action,
            status: "running",
            stage: "resolving",
          },
          controller: new AbortController(),
          work: Promise.resolve(),
          log: "",
        };
        this.jobs.set(input.id, job);
        job.work = this.perform(
          job,
          config,
          input.action === "install" ? input.version : undefined,
        )
          .then(
            () => {
              job.state.status = "succeeded";
            },
            (error) => {
              const unconfirmed =
                (error instanceof ExternalAgentError &&
                  error.code === "process_unconfirmed") ||
                (error instanceof ManagedProcessLaunchError &&
                  !error.child.exitConfirmed);
              job.state.status =
                job.controller.signal.aborted && !unconfirmed
                  ? "cancelled"
                  : "failed";
              job.state.error =
                error instanceof Error ? error.message : String(error);
              if (error instanceof ExternalAgentError)
                job.state.code = error.code;
            },
          )
          .finally(() => this.changed());
        this.changed();
      }
    }
    return this.snapshot();
  }
  private async run(
    job: Job,
    launch: Launch,
    args: string[],
    cwd: string,
  ): Promise<string> {
    const signal = job.controller.signal;
    signal.throwIfAborted();
    const child = await this.deps.spawn(
      launch.command,
      [...launch.args, ...args],
      {
        cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal,
      },
    );
    let output = "";
    const drained = Promise.all([
      finished(child.stdout, { cleanup: true }),
      finished(child.stderr, { cleanup: true }),
    ]);
    void drained.catch(() => {});
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      job.log += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      job.log += chunk;
    });
    try {
      await child.completion;
      if (!child.exitConfirmed)
        throw new ExternalAgentError(
          "process_unconfirmed",
          "Installer process exit is unconfirmed; its files are retained",
        );
      await drained;
      signal.throwIfAborted();
      if (child.exitCode !== 0)
        throw new Error(
          `Installer exited with ${child.exitCode}. See the installation log for details.`,
        );
      return output.trim();
    } catch (error) {
      if (!child.exitConfirmed)
        throw new ExternalAgentError(
          "process_unconfirmed",
          "Installer process exit is unconfirmed; its files are retained",
        );
      throw error;
    } finally {
      if (child.exitConfirmed) await child.release();
    }
  }
  private stage(job: Job, stage: ExternalAgentInstallation["stage"]) {
    job.state.stage = stage;
    this.changed();
  }
  private async perform(
    job: Job,
    config: ExternalAgentConfiguration,
    requestedVersion?: string,
  ) {
    const profile = getExternalAgentProfile(config.profileId ?? config.id);
    const signal = job.controller.signal;
    const managed = await this.inspect(config);
    if (job.state.operation === "uninstall") {
      if (!managed)
        throw new ExternalAgentError(
          "not_managed",
          "Only Varin-managed programs can be uninstalled here",
        );
      signal.throwIfAborted();
      this.stage(job, "removing");
      await this.deps.removeProgram(this.root(config.id));
      await this.activate(
        config,
        profile?.launch.command ?? config.command,
        profile?.launch.args ?? config.args,
        false,
      );
      // Entire root is owned by this configuration. User homes/config/history are never inside it.
      return;
    }
    if (!profile)
      throw new ExternalAgentError(
        "installation_unavailable",
        "This configuration uses an existing program",
      );
    assertProfilePlatform(profile, process.platform, process.arch);
    if (!profile.installation || profile.installation.kind === "external")
      throw new ExternalAgentError(
        "official_installer",
        "Use this product’s official installer on the selected execution Host",
      );
    const root = this.root(config.id);
    await mkdir(root, { recursive: true });
    let version: string;
    let npm: Launch | undefined;
    let binary:
      | { archive: string; cmd: string; args?: string[]; sha256?: string }
      | undefined;
    if (profile.installation.kind === "npm") {
      npm = await this.deps.executable({ ...config, command: "npm", args: [] });
      const result = await this.run(
        job,
        npm,
        [
          "view",
          `${profile.installation.packageName}@${requestedVersion?.trim() || "latest"}`,
          "version",
          "--json",
        ],
        root,
      );
      const resolved: unknown = JSON.parse(result);
      if (typeof resolved !== "string" || !resolved)
        throw new Error("Choose one published package version");
      version = resolved;
    } else {
      const response = await this.deps.fetch(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        { signal },
      );
      if (!response.ok)
        throw new Error(`Agent registry returned ${response.status}`);
      const registry = (await response.json()) as {
        agents: {
          id: string;
          version: string;
          distribution?: {
            binary?: Record<string, NonNullable<typeof binary>>;
          };
        }[];
      };
      const entry = registry.agents.find(
        (agent) =>
          agent.id ===
          (profile.id === "antigravity" ? "antigravity-acp" : profile.id),
      );
      const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
      binary = entry?.distribution?.binary?.[platform];
      if (!entry || !binary)
        throw new ExternalAgentError(
          "platform_unsupported",
          "The upstream registry has no distribution for this device",
        );
      version = entry.version;
      if (requestedVersion && requestedVersion !== version)
        throw new Error(`The upstream registry currently publishes ${version}`);
    }
    job.state.version = version;
    this.changed();
    if (job.state.operation === "check") return;
    const generation = randomUUID();
    const staging = path.join(root, `.preparing-${generation}`);
    const destination = path.join(root, generation);
    await mkdir(staging);
    let published = false;
    let archivePath: string | undefined;
    try {
      let command: string;
      if (npm) {
        this.stage(job, "installing");
        await this.run(
          job,
          npm,
          [
            "install",
            "--prefix",
            staging,
            "--no-audit",
            "--no-fund",
            "--engine-strict",
            `${profile.installation.packageName}@${version}`,
          ],
          staging,
        );
        const pkg = JSON.parse(
          await readFile(
            path.join(
              staging,
              "node_modules",
              profile.installation.packageName!,
              "package.json",
            ),
            "utf8",
          ),
        ) as { version: string; bin: string | Record<string, string> };
        const name =
          typeof pkg.bin === "string"
            ? profile.launch.command
            : Object.keys(pkg.bin).find(
                (name) => name === profile.launch.command,
              );
        if (!name)
          throw new Error(
            "The installed package does not publish the expected executable",
          );
        command = path.join(
          "node_modules",
          ".bin",
          `${name}${process.platform === "win32" ? ".cmd" : ""}`,
        );
        version = pkg.version;
      } else {
        this.stage(job, "downloading");
        const response = await this.deps.fetch(binary!.archive, { signal });
        if (!response.ok || !response.body)
          throw new Error(`Download returned ${response.status}`);
        const archive = path.join(root, `.download-${generation}`);
        archivePath = archive;
        const digest = createHash("sha256");
        const bytes = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        );
        bytes.on("data", (chunk: Buffer) => digest.update(chunk));
        await pipeline(bytes, createWriteStream(archive), { signal });
        if (binary!.sha256 && digest.digest("hex") !== binary!.sha256)
          throw new Error("Downloaded archive failed SHA-256 verification");
        this.stage(job, "installing");
        if (new URL(binary!.archive).pathname.endsWith(".zip")) {
          const zip = new AdmZip(archive);
          for (const entry of zip.getEntries())
            childPath(staging, entry.entryName);
          await zip.extractAllToAsync(staging, true, false);
        } else
          await extractTar({
            file: archive,
            cwd: staging,
            strict: true,
            preservePaths: false,
          });
        await rm(archive);
        command = binary!.cmd.replaceAll("\\", "/");
        if (process.platform !== "win32") {
          await chmod(childPath(staging, command), 0o755);
          if (profile.id === "antigravity")
            await chmod(path.join(staging, "localharness_external"), 0o755);
        }
      }
      signal.throwIfAborted();
      // Compare canonical paths so a symlink or junction above the generation is harmless.
      const canonicalStaging = await realpath(staging);
      const entry = await realpath(childPath(staging, command));
      childPath(canonicalStaging, path.relative(canonicalStaging, entry));
      await writeFile(
        path.join(staging, ".varin-installation.json"),
        JSON.stringify({
          profileId: profile.id,
          version,
          command,
        } satisfies Manifest),
      );
      await rename(staging, destination);
      published = true;
      signal.throwIfAborted();
      this.stage(job, "activating");
      await this.activate(
        config,
        childPath(destination, command),
        config.args,
        true,
      );
      job.state.version = version;
    } finally {
      if (archivePath) await rm(archivePath, { force: true });
      if (!published) {
        try {
          await this.deps.removeProgram(staging);
        } catch (error) {
          job.log += `\nPreparation files retained: ${error instanceof Error ? error.message : String(error)}\n`;
        }
      }
    }
  }
  private async activate(
    original: ExternalAgentConfiguration,
    command: string,
    args: string[],
    enabled: boolean,
  ) {
    const settings = await this.deps.settings();
    const current = settings.agents.find((agent) => agent.id === original.id);
    if (
      !current ||
      current.harness !== original.harness ||
      current.profileId !== original.profileId ||
      current.command !== original.command ||
      JSON.stringify(current.args) !== JSON.stringify(original.args)
    )
      throw new ExternalAgentError(
        "configuration_changed",
        "The program configuration changed during installation; the prepared installation was retained",
      );
    await this.deps.configure(
      {
        defaultAgent: enabled
          ? settings.defaultAgent
          : settings.defaultAgent === original.id
            ? null
            : settings.defaultAgent,
        agents: settings.agents.map((agent) =>
          agent.id === original.id
            ? {
                ...agent,
                command,
                args,
                enabled: enabled && agent.enabled,
                availability: enabled
                  ? (agent.availability ?? "enabled")
                  : "disabled",
              }
            : agent,
        ),
      },
      settings.revision,
      randomUUID(),
    );
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values())
      if (!["activating", "removing"].includes(job.state.stage))
        job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.work));
    this.changed();
  }
}
