import React from 'react';
import type { LaunchSelection } from '@varin/protocol';

const reasons: Record<string, string> = {
  'child-worker-disabled': 'Normal child delegation is disabled in agent settings',
  'child-settings-invalid': 'Agent settings are invalid',
  'child-settings-unavailable': 'Agent settings could not be read',
  'child-profile-disabled': 'Disabled in agent settings',
  'child-profile-unconfigured': 'No configured model',
  'child-profile-scope_unavailable': 'Not available in this work focus',
  'child-capability-unsupported': 'Selected capabilities are not available for this child runtime',
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
    <p className="mt-2 text-xs text-muted-foreground">Frozen for this launch. New inputs or an explicit model selection prepare current agent settings. A private working directory is not an OS sandbox.</p>
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
