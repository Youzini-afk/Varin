import type { AgentSettingsSnapshot } from '@varin/application-client';
import type { VarinExtensionServiceProvision } from '@varin/extension-contract';
import { extendToolConfiguration, type ExtensionToolConfiguration, type ExtensionToolRun } from './extension-tool-owner.js';
import type { ExtensionToolBinding, LaunchSource } from './protocol.generated.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Freeze the existing per-tool user/trusted-project switches for simple tool families. */
export function createToolFamilySettings(declarations: readonly VarinExtensionServiceProvision[], settings: (source: LaunchSource | null) => Promise<AgentSettingsSnapshot>, available: () => boolean = () => true) {
  const selected = (id: string) => declarations.some(declaration => declaration.id === id);
  const parse = (identity: string | null | undefined): string[] => {
    const value: unknown = identity ? JSON.parse(identity) : null;
    if (!object(value) || value.version !== 1 || !Array.isArray(value.disabled) || value.disabled.some(name => typeof name !== 'string')
      || Object.keys(value).some(name => name !== 'version' && name !== 'disabled')) throw new Error('The original tool settings are unavailable; prepare a new request');
    return value.disabled as string[];
  };
  return {
    assertEnabled(identity: string | null | undefined, name: string) { if (parse(identity).includes(name)) throw new Error(`${name} is disabled in this request`); },
    async prepareConfiguration(run: ExtensionToolRun, required: readonly ExtensionToolBinding[], previous?: ExtensionToolConfiguration): Promise<ExtensionToolConfiguration> {
      const captured = required.length ? null : await settings(run.source).then(snapshot => {
        const global = object(snapshot.global.harness) ? snapshot.global.harness : {};
        const project = snapshot.projectTrusted && object(snapshot.project.harness) ? snapshot.project.harness : {};
        const tools = { ...(object(global.tools) ? global.tools : {}), ...(object(project.tools) ? project.tools : {}) };
        for (const declaration of declarations) if (tools[declaration.tool!.name] !== undefined && typeof tools[declaration.tool!.name] !== 'boolean') throw new Error(`Invalid enable setting for ${declaration.tool!.name}`);
        return { disabled: declarations.filter(declaration => tools[declaration.tool!.name] === false).map(declaration => declaration.tool!.name), available: available() };
      }).then(value => ({ value }), error => ({ error }));
      return extendToolConfiguration(previous, (descriptor, original) => {
        if (!selected(descriptor.id)) return previous?.(descriptor, original) ?? original ?? null;
        if (original !== undefined) { parse(original); return original; }
        if (!captured) throw new Error('The original tool configuration was not retained');
        if ('error' in captured) throw captured.error;
        return JSON.stringify({ version: 1, disabled: captured.value.disabled });
      }, descriptor => selected(descriptor.id) && captured && 'value' in captured
        ? captured.value.available && !captured.value.disabled.includes(descriptor.tool!.name) : undefined);
    },
  };
}
