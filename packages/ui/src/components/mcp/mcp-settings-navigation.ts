import { create } from "zustand";
import { getRuntimeEndpointGeneration } from "@varin/application-client";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { useUIStore } from "@/stores/useUIStore";
import { requestSettingsNavigation } from "@/lib/settings/drafts";

type McpSettingsSelection = {
  mode: "new" | "server";
  name?: string;
  signIn?: boolean;
};
export const useMcpSettingsTarget = create<{
  target?: { host: number; directory: string; selection: McpSettingsSelection };
}>(() => ({}));

/** A transient navigation request, consumed by the existing settings editor. */
export function openMcpSettings(
  selection?: McpSettingsSelection,
  onNavigate?: () => void,
) {
  const host = getRuntimeEndpointGeneration();
  const directory = useDirectoryStore.getState().currentDirectory;
  requestSettingsNavigation(() => {
    if (
      host !== getRuntimeEndpointGeneration() ||
      directory !== useDirectoryStore.getState().currentDirectory
    )
      return;
    useMcpSettingsTarget.setState({
      target: selection ? { host, directory, selection } : undefined,
    });
    const ui = useUIStore.getState();
    ui.setSettingsPage("mcp-connections");
    ui.setSettingsDialogOpen(true);
    onNavigate?.();
  });
}
