import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'kernel', 'protocol', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const target = path.join(root, 'packages', 'web', 'application-host', 'lib', 'kernel', 'protocol.generated.ts');
const rustTarget = path.join(root, 'kernel', 'crates', 'varin-kernel', 'src', 'protocol_generated.rs');
const protocolTarget = path.join(root, 'packages', 'protocol', 'src', 'agent-runtime.generated.ts');
const extensionModelsTarget = path.join(root, 'packages', 'extension-contract', 'src', 'model-protocol.generated.ts');
const extensionToolsTarget = path.join(root, 'packages', 'extension-contract', 'src', 'nested-tools.generated.ts');
const runtimeTypesTarget = path.join(root, 'kernel', 'crates', 'varin-runtime', 'src', 'types_generated.rs');
const structs = Object.entries(schema.runtimeStructs ?? {}).map(([name, spec]) => {
  const fields = Object.entries(spec.fields).map(([key, value]) => {
    let type = ({string:"String", number:"u64", boolean:"bool", unknown:"serde_json::Value", "string | null":"Option<String>", "number | null":"Option<u64>"})[value.type];
    if (!type && schema.runtimeEnums?.[value.type]) type = value.type;
    if (!type && schema.dto?.[value.type]?.rustType) type = schema.dto[value.type].rustType.replace(/^varin_runtime::/, "crate::");
    if (value.optional && type && !type.startsWith("Option<")) type = `Option<${type}>`;
    if (!type) throw new Error(`Unsupported runtime field type ${value.type}`);
    const field = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return `    pub ${field}: ${type},`;
  });
  return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct ${name} {\n${fields.join("\n")}\n}\n`;
}).join("\n");
const taggedUnions = Object.entries(schema.dto ?? {}).filter(([, spec]) => spec.taggedUnion);
const pascal = value => value.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('');
const rustField = field => field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const runtimeTaggedUnions = taggedUnions.map(([name, spec]) => `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]\n#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]\npub enum ${name} {\n${Object.entries(spec.taggedUnion).map(([kind, fields]) => `    ${pascal(kind)}${Object.keys(fields).length ? ` { ${Object.entries(fields).map(([field, type]) => `${rustField(field) !== field ? `#[serde(rename = ${JSON.stringify(field)})] ` : ''}${rustField(field)}: ${type === 'string' ? 'String' : type}`).join(', ')} }` : ''},`).join('\n')}\n}\n`).join('\n');
const avatarTypes = 'export const AGENT_AVATAR_IDS = ' + JSON.stringify(schema.agentAvatars) + ' as const;\nexport type AgentAvatarId = typeof AGENT_AVATAR_IDS[number];\n\n';
const avatarRust = 'pub const AGENT_AVATAR_IDS: &[&str] = &[' + schema.agentAvatars.map(id => JSON.stringify(id)).join(', ') + '];\n\n';
const runtimeTypesGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\nuse serde::{Deserialize, Serialize};\n\n' + Object.entries(schema.runtimeEnums ?? {}).map(([name, variants]) => `#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]\n#[serde(rename_all = "snake_case")]\npub enum ${name} {\n${variants.map(v => `    ${v},`).join('\n')}\n}\n`).join('\n') + '\n' + avatarRust + structs + '\n' + runtimeTaggedUnions;
const checkOnly = process.argv.includes('--check');
const methods = Object.keys(schema.methods).map((method) => `  | ${JSON.stringify(method)}`).join('\n');
const methodParams = schema.methodParams ?? {};
const renderType = (type) => type === 'protocolVersion' ? 'typeof KERNEL_PROTOCOL_VERSION' : type;
const renderDto = (name, spec) => {
  if (spec.raw) return spec.raw.replaceAll('$protocolVersion', String(schema.protocolVersion));
  if (spec.taggedUnion) return `export type ${name} = ${Object.entries(spec.taggedUnion).map(([kind, fields]) => `{kind:${JSON.stringify(kind)}${Object.entries(fields).map(([field,type]) => `;${field}:${type}`).join('')}}`).join(' | ')};`;
  const generic = spec.generic ? `<${spec.generic}>` : '';
  const extendsClause = spec.extends?.length ? ` extends ${spec.extends.join(', ')}` : '';
  const fields = Object.entries(spec.fields ?? {}).map(([field, descriptor]) => (
    `  ${field}${descriptor.optional ? '?' : ''}: ${renderType(descriptor.type)};`
  ));
  if (spec.index) fields.push(`  ${spec.index}`);
  if (fields.length === 0 && !extendsClause) return `export type ${name}${generic} = Record<string, never>;`;
  return `export interface ${name}${generic}${extendsClause} {\n${fields.join('\n')}\n}`;
};
const renderRequestUnion = () => {
  const requests = Object.entries(methodParams).map(([method, paramsType]) => `  | {\n      v: typeof KERNEL_PROTOCOL_VERSION;\n      kind: "request";\n      id: string;\n      method: ${JSON.stringify(method)};\n      params: ${paramsType};\n      epoch?: string;\n      grantId?: string;\n    }`);
  requests.push(`  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "cancel"; id: string; epoch?: string; grantId?: string; }`);
  return `export type KernelRequest =\n${requests.join('\n')};`;
};
const renderMethodParams = () => `export type KernelMethodParams = {\n${Object.entries(methodParams).map(([method, paramsType]) => `  ${JSON.stringify(method)}: ${paramsType};`).join('\n')}\n};`;
const dtoEntries = Object.entries(schema.dto ?? {}).filter(([name]) => !(schema.requestUnion && name === 'KernelRequest'));
const extensionToolNames = ['ExecutionError', 'Outcome', 'Effect', 'Lifetime', 'OperationCallCompletion', 'NestedToolInput', 'NestedToolReceipt', 'NestedToolSummary', 'NestedToolInspection', 'LaunchTool', 'ToolMetadata', 'ToolRequirements', 'OutputEvidenceRef', 'ContentProvenance', 'OutputSource', 'ContentRef', 'IncomingMedia', 'StoredMedia', 'ResolvedMedia', 'OutputPart', 'OutputBody', 'ToolOrigin'];
const extensionToolsGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\n\n'
  + extensionToolNames.map(name => renderDto(name, schema.dto[name])).join('\n\n') + '\n';
const extensionModelsGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\nimport type { ExecutionError, Outcome, Effect, Lifetime, OutputBody, ResolvedMedia, ContentProvenance, LaunchTool } from \'./nested-tools.generated.js\';\n\n'
  + ["HistoryRange", "ModelOpaqueItem", "ModelToolCall", "ModelToolCompletion", "ModelContent", "ModelConversationItem", "RequestBinding", "RequestOrigin", "RequestView", "ModelUsageReceipt", "ProviderEvent", "FinishReason", "ModelProtocolCall", "ModelProtocolResult", "ModelSessionConfiguration", "TokenizerBinding", "ModelHttpConfiguration", "ResourceActivation", "AgentResourceReference"].map(name => renderDto(name, schema.dto[name])).join('\n\n') + '\n';
const protocolGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\n\n' + avatarTypes + dtoEntries.filter(([name]) => (schema.runtimeExports ?? []).includes(name)).map(([name, spec]) => renderDto(name, spec)).join('\n\n') + '\n';
const generated = `/**
 * Generated from \`kernel/protocol/schema.json\`.
 * Do not hand-edit the wire shapes; run \`node scripts/generate-kernel-protocol.mjs\`.
 */

export const KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const;
export const KERNEL_REQUEST_WINDOW = ${schema.requestWindow} as const;
export const KERNEL_MAX_FRAME_BYTES = ${schema.maxFrameBytes} as const;
export const KERNEL_CONTROL_METHODS = ${JSON.stringify(schema.controlMethods)} as const;
export const KERNEL_CONTROL_RESPONSE_METHODS = ${JSON.stringify(schema.controlResponseMethods)} as const;
export const KERNEL_DEFERRED_RESPONSE_METHODS = ${JSON.stringify(schema.deferredResponseMethods)} as const;
export const KERNEL_INPUT_ORDER_PARAMS = ${JSON.stringify(schema.inputOrderParams)} as const;
export const KERNEL_RUNTIME_DATA_METHODS = ${JSON.stringify(schema.runtimeDataMethods ?? [])} as const;
export const KERNEL_PROTOCOL_SCHEMA = "varin.kernel.v${schema.protocolVersion}" as const;

export type KernelMethod =
${methods};

${avatarTypes}
${dtoEntries.map(([name, spec]) => renderDto(name, spec)).join('\n\n')}

export type McpBuiltinOperation = ${schema.mcpCapabilities.map(value => JSON.stringify(value.operation)).join(" | ")};
export const MCP_CAPABILITIES: readonly (LaunchTool & { route: McpRoute; operation: McpBuiltinOperation })[] = ${JSON.stringify(schema.mcpCapabilities, null, 2)};

${renderMethodParams()}

${schema.requestUnion ? renderRequestUnion() : ''}
`;

const snakeCase = (value) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[-.]/g, '_')
  .toLowerCase();
const rustType = (type) => {
  const generic = /^(\w+)<(.+)>$/u.exec(type);
  if (generic && schema.dto?.[generic[1]]?.rustType) return `${schema.dto[generic[1]].rustType}<${rustType(generic[2])}>`;
  if (schema.dto?.[type]?.rustType) return schema.dto[type].rustType;
  if (schema.dto?.[type]?.taggedUnion) return `varin_runtime::${type}`;
  if (schema.runtimeEnums?.[type]) return `varin_runtime::${type}`;
  if (type.endsWith('[]')) return `Vec<${rustType(type.slice(0, -2))}>`;
  if (type === 'string') return 'String';
  const map = /^Record<string, (.+)>$/u.exec(type);
  if (map) return `std::collections::BTreeMap<String, ${rustType(map[1])}>`;
  if (type === 'number' || type === 'protocolVersion') return 'i64';
  if (type === 'boolean') return 'bool';
  if (type === 'unknown') return 'Value';
  if (type === 'string | null') return 'RequiredNullable<String>';
  if (type === 'number | null') return 'RequiredNullable<i64>';
  if (type === 'boolean | null') return 'RequiredNullable<bool>';
  if (type.endsWith(' | null')) return `RequiredNullable<${rustType(type.slice(0, -7))}>`;
  if (type === 'KernelBranchState') return 'PathState';
  return type;
};
const rustDtoNames = new Set([...Object.values(methodParams), ...(schema.privateDtos ?? [])]);
for (let changed = true; changed;) {
  changed = false;
  for (const name of [...rustDtoNames]) {
    const spec = schema.dto?.[name];
    if (!spec?.fields) continue;
    for (const descriptor of Object.values(spec.fields)) {
      let bare = descriptor.type;
      for (;;) {
        const inner = bare.replace(/\[\]$/u, '').replace(/ \| null$/u, '').replace(/^Record<string, (.+)>$/u, '$1');
        if (inner === bare) break;
        bare = inner;
      }
      if (schema.dto?.[bare] && !schema.dto[bare].raw && !schema.dto[bare].rustType && !rustDtoNames.has(bare)) {
        rustDtoNames.add(bare);
        changed = true;
      }
    }
  }
}
const renderRustDto = (name) => {
  const spec = schema.dto[name];
  if (spec.taggedUnion) return `pub(crate) type ${name} = varin_runtime::${name};`;
  if (spec.rustType && !spec.fields) return `pub(crate) type ${name} = ${spec.rustType};`;
  const fields = Object.entries(spec.fields ?? {}).map(([field, descriptor]) => {
    const type = rustType(descriptor.type);
    const rendered = descriptor.optional ? `Option<${type}>` : type;
    const wireName = field.includes("_") ? `    #[serde(rename = ${JSON.stringify(field)})]\n` : "";
    return `${wireName}    pub(crate) ${snakeCase(field)}: ${rendered},`;
  });
  return `#[derive(Clone, Debug, Deserialize${spec.serialize ? ", serde::Serialize" : ""})]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub(crate) struct ${name} {\n${fields.join('\n')}\n}`;
};
const workingDocumentDto = {
  'working.result': 'KernelWorkingResultDocument',
  'working.draft': 'KernelWorkingDraftDocument',
  'working.verification.child': 'KernelWorkingVerificationDocument',
  'working.verification.parent': 'KernelWorkingVerificationDocument',
  'working.review': 'KernelWorkingReviewDocument',
};
const unformattedRust = `// Generated from kernel/protocol/schema.json. Do not hand-edit.\n#![allow(dead_code)]\n\nuse crate::model::PathState;\nuse serde::Deserialize;\nuse serde_json::Value;\n\npub(crate) const KERNEL_PROTOCOL_VERSION: u64 = ${schema.protocolVersion};\npub(crate) const KERNEL_MAX_FRAME_BYTES: usize = ${schema.maxFrameBytes};\npub(crate) const KERNEL_REQUEST_WINDOW: usize = ${schema.requestWindow};\npub(crate) const KERNEL_CONTROL_METHODS: &[&str] = &[${schema.controlMethods.map(value => JSON.stringify(value)).join(", ")}];\npub(crate) const KERNEL_CONTROL_RESPONSE_METHODS: &[&str] = &[${schema.controlResponseMethods.map(value => JSON.stringify(value)).join(", ")}];\npub(crate) const KERNEL_DEFERRED_RESPONSE_METHODS: &[&str] = &[${schema.deferredResponseMethods.map(value => JSON.stringify(value)).join(", ")}];\npub(crate) const KERNEL_INPUT_ORDER_PARAMS: &[(&str,&str)] = &[${Object.entries(schema.inputOrderParams).map(([method,field]) => `(${JSON.stringify(method)},${JSON.stringify(field)})`).join(", ")}];\npub(crate) const KERNEL_RUNTIME_DATA_METHODS: &[&str] = &[${(schema.runtimeDataMethods ?? []).map(value => JSON.stringify(value)).join(", ")}];\n\n#[derive(Clone, Debug, Deserialize)]\n#[serde(transparent)]\npub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);\n\n${[...rustDtoNames].map(renderRustDto).join('\n\n')}\n\npub(crate) fn validate_generated_method_params(method: &str, params: &Value) -> Result<(), String> {\n    match method {\n${Object.entries(methodParams).map(([method, paramsType]) => `        ${JSON.stringify(method)} => serde_json::from_value::<${paramsType}>(params.clone()).map(|_| ()).map_err(|error| error.to_string()),`).join('\n')}\n        _ => Ok(()),\n    }\n}\n\npub(crate) fn validate_generated_working_document(record_type: &str, document: &Value) -> Result<(), String> {\n    match record_type {\n${Object.entries(workingDocumentDto).map(([recordType, dto]) => `        ${JSON.stringify(recordType)} => serde_json::from_value::<${dto}>(document.clone()).map(|_| ()).map_err(|error| error.to_string()),`).join('\n')}\n        _ => Ok(()),\n    }\n}\n`;
const rustfmt = spawnSync(process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt', ['--emit', 'stdout', '--edition', '2021'], {
  input: unformattedRust,
  encoding: 'utf8',
  windowsHide: true,
});
if (rustfmt.status !== 0 || !rustfmt.stdout) {
  throw new Error(`Unable to format generated Rust protocol DTOs: ${rustfmt.stderr || `rustfmt exited ${rustfmt.status}`}`);
}
const rustGenerated = rustfmt.stdout;

if (checkOnly) {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const existingRust = fs.existsSync(rustTarget) ? fs.readFileSync(rustTarget, 'utf8') : '';
  const existingTypes = fs.existsSync(runtimeTypesTarget) ? fs.readFileSync(runtimeTypesTarget, "utf8") : "";
  const existingProtocol = fs.existsSync(protocolTarget) ? fs.readFileSync(protocolTarget, 'utf8') : '';
  const existingExtensionModels = fs.existsSync(extensionModelsTarget) ? fs.readFileSync(extensionModelsTarget, 'utf8') : '';
  const existingExtensionTools = fs.existsSync(extensionToolsTarget) ? fs.readFileSync(extensionToolsTarget, 'utf8') : '';
  if (existingExtensionModels !== extensionModelsGenerated || existingExtensionTools !== extensionToolsGenerated || existing !== generated || existingRust !== rustGenerated || existingTypes !== runtimeTypesGenerated || existingProtocol !== protocolGenerated) {
    const stale = [existingExtensionModels !== extensionModelsGenerated ? extensionModelsTarget : null, existingExtensionTools !== extensionToolsGenerated ? extensionToolsTarget : null, existing !== generated ? target : null, existingRust !== rustGenerated ? rustTarget : null, existingTypes !== runtimeTypesGenerated ? runtimeTypesTarget : null, existingProtocol !== protocolGenerated ? protocolTarget : null].filter(Boolean);
    console.error(`Kernel protocol DTO is out of date: ${stale.map((entry) => path.relative(root, entry)).join(', ')}`);
    process.exit(1);
  }
  console.log(`Kernel protocol ${schema.protocolVersion} is up to date.`);
} else {
  fs.writeFileSync(extensionModelsTarget, extensionModelsGenerated);
  fs.writeFileSync(extensionToolsTarget, extensionToolsGenerated);
  fs.writeFileSync(protocolTarget, protocolGenerated);
  fs.writeFileSync(target, generated);
  fs.writeFileSync(rustTarget, rustGenerated);
  fs.writeFileSync(runtimeTypesTarget, runtimeTypesGenerated);
  console.log(`Kernel protocol ${schema.protocolVersion} is generated at ${path.relative(root, target)}`);
}
