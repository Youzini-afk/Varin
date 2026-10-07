import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DefaultPackageManager,
  type PackageSource,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  HostEventData,
  PackageDescriptor,
  PiPackageScope,
} from "@varin/protocol";
import { HostError } from "./errors.js";
import {
  packageSourceEnabled,
  packageSourceValue,
  setPackageSourceEnabled,
} from "./package-activation.js";
import { packageManifestFromPath, packageNameFromSource } from "./package-descriptor.js";

interface PackageAuthorityHostOptions {
  agentDir: string;
  cwd: string;
  emitProgress(data: HostEventData<"package.progress">): void;
  projectTrustOverride?: boolean;
}

/**
 * Pi package authority that never creates an AgentSession or executes extensions.
 * A broken package must remain removable and package management must remain available
 * even when that package cannot be imported by a real workspace/session worker.
 */
export class PackageAuthorityHost {
  readonly #agentDir: string;
  readonly #cwd: string;
  readonly #emitProgress: PackageAuthorityHostOptions["emitProgress"];
  readonly #settings: SettingsManager;
  readonly #projectTrusted: boolean;

  constructor(options: PackageAuthorityHostOptions) {
    this.#agentDir = resolve(options.agentDir);
    this.#cwd = resolve(options.cwd);
    this.#emitProgress = options.emitProgress;
    this.#projectTrusted = this.#cwd === this.#agentDir
      || options.projectTrustOverride === true
      || new ProjectTrustStore(this.#agentDir).get(this.#cwd) === true;
    this.#settings = SettingsManager.create(this.#cwd, this.#agentDir, {
      projectTrusted: this.#projectTrusted,
    });
  }

  listPackages(): PackageDescriptor[] {
    const manager = this.#packageManager();
    return manager.listConfiguredPackages()
      .map((entry) => {
        const manifest = packageManifestFromPath(entry.installedPath);
        const settings = entry.scope === "project"
          ? this.#settings.getProjectSettings()
          : this.#settings.getGlobalSettings();
        const configured = (settings.packages ?? []).find((candidate) => (
          packageSourceValue(candidate) === entry.source
        ));
        return {
          enabled: configured === undefined ? true : packageSourceEnabled(configured),
          installed: entry.installedPath !== undefined && existsSync(entry.installedPath),
          name: manifest.name ?? packageNameFromSource(entry.source),
          ...(entry.installedPath === undefined ? {} : { resolvedPath: entry.installedPath }),
          scope: entry.scope === "project" ? "project" : "global",
          source: entry.source,
          structured: entry.filtered,
          ...(manifest.version === undefined ? {} : { version: manifest.version }),
        };
      });
  }

  async refreshPackages(): Promise<PackageDescriptor[]> {
    await this.#reloadSettings();
    return this.listPackages();
  }

  async installPackage(source: string, scope: PiPackageScope): Promise<PackageDescriptor> {
    this.#assertScopeAllowed(scope);
    await this.#reloadSettings();
    const manager = this.#packageManager();
    const local = scope === "project";
    await manager.installAndPersist(source, { local });
    await this.#flushSettings();
    const resolvedPath = manager.getInstalledPath(source, local ? "project" : "user");
    return this.listPackages().find((entry) => (
      entry.scope === scope
      && (entry.source === source || (resolvedPath !== undefined && entry.resolvedPath === resolvedPath))
    )) ?? {
      enabled: true,
      installed: resolvedPath !== undefined,
      name: packageNameFromSource(source),
      ...(resolvedPath === undefined ? {} : { resolvedPath }),
      scope,
      source,
      structured: false,
    };
  }

  async setPackageEnabled(
    source: string,
    scope: PiPackageScope,
    enabled: boolean,
  ): Promise<PackageDescriptor> {
    this.#assertScopeAllowed(scope);
    await this.#reloadSettings();
    const current = scope === "project"
      ? this.#settings.getProjectSettings().packages ?? []
      : this.#settings.getGlobalSettings().packages ?? [];
    const index = current.findIndex((entry) => packageSourceValue(entry) === source);
    if (index === -1) {
      throw new HostError("package_not_configured", `Pi package is not configured: ${source}`);
    }
    const next: PackageSource[] = [...current];
    next[index] = setPackageSourceEnabled(next[index] as PackageSource, enabled);
    if (scope === "project") this.#settings.setProjectPackages(next);
    else this.#settings.setPackages(next);
    await this.#flushSettings();
    const descriptor = this.listPackages().find((entry) => (
      entry.scope === scope && entry.source === source
    ));
    if (!descriptor) {
      throw new HostError("package_not_configured", `Pi package is not configured: ${source}`);
    }
    return descriptor;
  }

  async removePackage(source: string, scope: PiPackageScope): Promise<boolean> {
    this.#assertScopeAllowed(scope);
    await this.#reloadSettings();
    const manager = this.#packageManager();
    const local = scope === "project";
    const configured = manager.listConfiguredPackages().find((entry) => (
      entry.scope === (local ? "project" : "user") && entry.source === source
    ));
    let removed = await manager.removeAndPersist(source, { local });
    if (!removed && configured?.installedPath) {
      removed = manager.removeSourceFromSettings(configured.installedPath, { local });
    }
    if (!removed && configured) {
      const current = local
        ? this.#settings.getProjectSettings().packages ?? []
        : this.#settings.getGlobalSettings().packages ?? [];
      const next = current.filter((entry) => packageSourceValue(entry) !== configured.source);
      if (next.length !== current.length) {
        if (local) this.#settings.setProjectPackages(next);
        else this.#settings.setPackages(next);
        removed = true;
      }
    }
    await this.#flushSettings();
    return removed;
  }

  async updatePackages(source?: string): Promise<PackageDescriptor[]> {
    await this.#reloadSettings();
    await this.#packageManager().update(source);
    return this.listPackages();
  }

  #packageManager(): DefaultPackageManager {
    const manager = new DefaultPackageManager({
      agentDir: this.#agentDir,
      cwd: this.#cwd,
      settingsManager: this.#settings,
    });
    manager.setProgressCallback((progress) => {
      const operation = progress.action === "remove"
        ? "remove"
        : progress.action === "update"
          ? "update"
          : "install";
      this.#emitProgress({
        message: progress.message ?? `${progress.action}: ${progress.source}`,
        operation,
        source: progress.source,
      });
    });
    return manager;
  }

  #assertScopeAllowed(scope: PiPackageScope): void {
    if (scope === "project" && !this.#projectTrusted) {
      throw new HostError(
        "project_untrusted",
        "Trust this project before changing its Pi packages",
      );
    }
  }

  async #reloadSettings(): Promise<void> {
    await this.#settings.reload();
    const errors = this.#settings.drainErrors();
    if (errors.length > 0) {
      throw new HostError(
        "settings_read_failed",
        errors.map((entry) => entry.error.message).join("; "),
      );
    }
  }

  async #flushSettings(): Promise<void> {
    await this.#settings.flush();
    const errors = this.#settings.drainErrors();
    if (errors.length === 0) return;
    await this.#settings.reload();
    throw new HostError(
      "settings_write_failed",
      errors.map((entry) => entry.error.message).join("; "),
    );
  }
}
