import React from 'react';
import type { LaunchSelection } from '@varin/protocol';
import { useUIStore } from '@/stores/useUIStore';
import { selectAgentProfilesRuntime } from '@/components/sections/agents/agent-profiles-store';

const reasons: Record<string, string> = {
  'child-worker-disabled': 'Normal child delegation is disabled in agent settings',
  'child-settings-invalid': 'Agent settings are invalid. Review the saved configuration.',
  'child-settings-unavailable': 'Agent settings could not be read. Check access to the settings file.',
  'child-profile-disabled': 'Disabled in agent settings',
  'child-profile-unconfigured': 'Choose a model for this profile in Agent settings.',
  'child-profile-runtime_unconfigured': 'Select tools for this profile in Agent settings.',
  'child-profile-scope_unavailable': 'Not available in this work focus',
  'child-capability-unsupported': 'Edit the Agent profile to replace these unsupported tools',
  'child-physical-source-required': 'These capabilities require a private physical working copy',
  'child-model-unconfigured': 'No configured model',
  'child-model-unavailable': 'The configured model or its original account is unavailable',
};

/** Displays the same frozen selection that execution owns, never a live settings preview. */
export function ThreadChildProfiles({ launch }: { launch: LaunchSelection }) {
  const catalog = launch.child_dispatch;
  if (!catalog) return null;
  const hostNames = new Set([...launch.extension_bindings.map(binding => binding.tool.name), ...(launch.mcp_binding?.tools.map(tool => tool.name) ?? [])]);
  const names = new Set([...catalog.native_capabilities.map(tool => tool.name), ...hostNames]);
  return <details className="mx-auto max-w-3xl rounded border p-3 text-sm">
    <summary className="cursor-pointer">Child execution choices</summary>
    <p className="mt-2 text-xs text-muted-foreground">Accepted tasks keep these choices. Changes apply to future tasks.</p>
    <button type="button" className="mt-1 text-xs underline" onClick={() => {
      selectAgentProfilesRuntime('agent');
      const settings = useUIStore.getState();
      settings.setSettingsPage('agents');
      settings.setSettingsDialogOpen(true);
    }}>Configure Agent profiles</button>
    {catalog.normal_unavailable && <p>{reasons[catalog.normal_unavailable.code] ?? catalog.normal_unavailable.code}</p>}
    {catalog.presets.map(preset => {
      const unsupported = preset.tools.filter(name => !names.has(name));
      const physical = preset.work_mode === 'read_only' ? preset.tools.filter(name => !hostNames.has(name)
        && catalog.native_capabilities.some(tool => tool.name === name && tool.source_requirement === 'physical')) : [];
      const unavailable = preset.unavailable ?? (unsupported.length ? { code: 'child-capability-unsupported', capabilities: unsupported }
        : physical.length ? { code: 'child-physical-source-required', capabilities: physical } : null);
      return <div key={preset.id} className="mt-2">
      <div>{preset.name} · {preset.id} · {preset.work_mode === 'read_only' ? 'Read-only source' : 'Private working copy'}</div>
      <div className="text-xs text-muted-foreground">{preset.model_source === 'inherit' ? 'Inherits the request model' : preset.model?.configuration.model ?? 'Configured model unavailable'}</div>
      <div className="text-xs text-muted-foreground">{preset.tools.join(', ') || 'No tools'}</div>
      {unavailable && <p>{reasons[unavailable.code] ?? unavailable.code}{unavailable.capabilities.length ? `: ${unavailable.capabilities.join(', ')}` : ''}</p>}
    </div>; })}
  </details>;
}
