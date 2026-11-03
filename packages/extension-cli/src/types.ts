import type {
  VarinExtensionHostEntrypoint,
  VarinExtensionManifest,
  VarinExtensionSurfaceEntrypoint,
} from "@varin/extension-contract";

export interface ExtensionBuildEntrypointConfig {
  source: string;
}

export interface ExtensionBuildConfig {
  entrypoints?: Record<string, ExtensionBuildEntrypointConfig | string>;
}

export interface ExtensionPackageMetadata {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  varin?: {
    build?: ExtensionBuildConfig;
  };
  scripts?: Record<string, string>;
  type?: string;
  version?: string;
}

export interface LoadedExtensionProject {
  directory: string;
  manifest: VarinExtensionManifest;
  manifestPath: string;
  packageJson: ExtensionPackageMetadata;
  packageJsonPath: string;
}

export interface CheckResult {
  authorDiagnostics: import("@varin/extension-contract").VarinSurfaceAuthorDiagnostic[];
  project: LoadedExtensionProject;
  referencedFiles: string[];
  missingFiles: string[];
  incompatibleContributions: Array<{
    id: string;
    kind: string;
    contractVersion: number;
    supportedVersions: number[];
  }>;
}

export interface BuildOutput {
  entrypointId: string;
  file: string;
  kind: "host" | "surface";
  mode: "browser" | "node";
}

export interface BuildResult {
  outputs: BuildOutput[];
  project: LoadedExtensionProject;
}

export interface TestResult {
  host: "skipped" | "passed";
  project: LoadedExtensionProject;
  surfaces: Array<{
    entrypointId: string;
    mode: "declarative" | "managed" | "isolated" | "native";
    result: "skipped" | "passed";
  }>;
}

export type ExecutableEntrypoint = VarinExtensionHostEntrypoint | VarinExtensionSurfaceEntrypoint;
