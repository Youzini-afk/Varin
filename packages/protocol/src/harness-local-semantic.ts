/**
 * Application Host optional local semantic component status.
 *
 * The component is deliberately outside the normal application package. The
 * UI can use this DTO to present install progress without knowing anything
 * about archives, model files, or the native ONNX runtime.
 */

export type LocalSemanticInstallStage = "downloading" | "extracting" | "verifying";

export type LocalSemanticStatus = {
  status: "not-installed" | "installing" | "ready" | "failed";
  version?: string;
  installedBytes?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  stage?: LocalSemanticInstallStage;
  error?: string;
};
