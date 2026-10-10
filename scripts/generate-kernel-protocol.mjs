import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'kernel', 'protocol', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const target = path.join(root, 'packages', 'web', 'application-host', 'lib', 'kernel', 'protocol.generated.ts');
const rustTarget = path.join(root, 'kernel', 'crates', 'varin-kernel', 'src', 'protocol_generated.rs');
const protocolTarget = path.join(root, 'packages', 'protocol', 'src', 'agent-runtime.generated.ts');
const runtimeTypesTarget = path.join(root, 'kernel', 'crates', 'varin-runtime', 'src', 'types_generated.rs');
const structs = Object.entries(schema.runtimeStructs ?? {}).map(([name, spec]) => {
  const fields = Object.entries(spec.fields).map(([key, value]) => {
    let type = ({string:"String", number:"u64", boolean:"bool", unknown:"serde_json::Value", "string | null":"Option<String>", "number | null":"Option<u64>"})[value.type];
    if (value.optional && type && !type.startsWith("Option<")) type = `Option<${type}>`;
    if (!type) throw new Error(`Unsupported runtime field type ${value.type}`);
    const field = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return `    pub ${field}: ${type},`;
  });
  return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct ${name} {\n${fields.join("\n")}\n}\n`;
}).join("\n");
const runtimeTypesGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\nuse serde::{Deserialize, Serialize};\n\n' + Object.entries(schema.runtimeEnums ?? {}).map(([name, variants]) => `#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]\n#[serde(rename_all = "snake_case")]\npub enum ${name} {\n${variants.map(v => `    ${v},`).join('\n')}\n}\n`).join('\n') + '\n' + structs;
const checkOnly = process.argv.includes('--check');
const methods = Object.keys(schema.methods).map((method) => `  | ${JSON.stringify(method)}`).join('\n');
const methodParams = schema.methodParams ?? {};
const renderType = (type) => type === 'protocolVersion' ? 'typeof KERNEL_PROTOCOL_VERSION' : type;
const renderDto = (name, spec) => {
  if (spec.raw) return spec.raw;
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
const protocolGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\n\n' + dtoEntries.filter(([name]) => (schema.runtimeExports ?? []).includes(name)).map(([name, spec]) => renderDto(name, spec)).join('\n\n') + '\n';
const generated = `/**
 * Generated from \`kernel/protocol/schema.json\`.
 * Do not hand-edit the wire shapes; run \`node scripts/generate-kernel-protocol.mjs\`.
 */

export const KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const;
export const KERNEL_REQUEST_WINDOW = ${schema.requestWindow} as const;
export const KERNEL_MAX_FRAME_BYTES = ${schema.maxFrameBytes} as const;
export const KERNEL_CONTROL_METHODS = ${JSON.stringify(schema.controlMethods)} as const;
export const KERNEL_CONTROL_RESPONSE_METHODS = ${JSON.stringify(schema.controlResponseMethods)} as const;
export const KERNEL_INPUT_ORDER_PARAMS = ${JSON.stringify(schema.inputOrderParams)} as const;
export const KERNEL_RUNTIME_DATA_METHODS = ${JSON.stringify(schema.runtimeDataMethods ?? [])} as const;
export const KERNEL_PROTOCOL_SCHEMA = "varin.kernel.v${schema.protocolVersion}" as const;

export type KernelMethod =
${methods};

${dtoEntries.map(([name, spec]) => renderDto(name, spec)).join('\n\n')}

${renderMethodParams()}

${schema.requestUnion ? renderRequestUnion() : ''}
`;

const snakeCase = (value) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[-.]/g, '_')
  .toLowerCase();
const rustType = (type) => {
  if (schema.dto?.[type]?.rustType) return schema.dto[type].rustType;
  if (schema.runtimeEnums?.[type]) return `varin_runtime::${type}`;
  if (type.endsWith('[]')) return `Vec<${rustType(type.slice(0, -2))}>`;
  if (type === 'string') return 'String';
  if (type === 'Record<string, string>') return 'std::collections::BTreeMap<String, String>';
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
const rustDtoNames = new Set(Object.values(methodParams));
for (let changed = true; changed;) {
  changed = false;
  for (const name of [...rustDtoNames]) {
    const spec = schema.dto?.[name];
    if (!spec?.fields) continue;
    for (const descriptor of Object.values(spec.fields)) {
      const bare = descriptor.type.replace(/\[\]$/u, '').replace(/ \| null$/u, '');
      if (schema.dto?.[bare] && !schema.dto[bare].raw && !schema.dto[bare].rustType && !rustDtoNames.has(bare)) {
        rustDtoNames.add(bare);
        changed = true;
      }
    }
  }
}
const renderRustDto = (name) => {
  const spec = schema.dto[name];
  const fields = Object.entries(spec.fields ?? {}).map(([field, descriptor]) => {
    const type = rustType(descriptor.type);
    const rendered = descriptor.optional ? `Option<${type}>` : type;
    const wireName = field.includes("_") ? `    #[serde(rename = ${JSON.stringify(field)})]\n` : "";
    return `${wireName}    pub(crate) ${snakeCase(field)}: ${rendered},`;
  });
  return `#[derive(Clone, Debug, Deserialize)]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub(crate) struct ${name} {\n${fields.join('\n')}\n}`;
};
const workingDocumentDto = {
  'working.result': 'KernelWorkingResultDocument',
  'working.draft': 'KernelWorkingDraftDocument',
  'working.verification.child': 'KernelWorkingVerificationDocument',
  'working.verification.parent': 'KernelWorkingVerificationDocument',
  'working.review': 'KernelWorkingReviewDocument',
};
const unformattedRust = `// Generated from kernel/protocol/schema.json. Do not hand-edit.\n#![allow(dead_code)]\n\nuse crate::model::PathState;\nuse serde::Deserialize;\nuse serde_json::Value;\n\npub(crate) const KERNEL_PROTOCOL_VERSION: u64 = ${schema.protocolVersion};\npub(crate) const KERNEL_MAX_FRAME_BYTES: usize = ${schema.maxFrameBytes};\npub(crate) const KERNEL_REQUEST_WINDOW: usize = ${schema.requestWindow};\npub(crate) const KERNEL_CONTROL_METHODS: &[&str] = &[${schema.controlMethods.map(value => JSON.stringify(value)).join(", ")}];\npub(crate) const KERNEL_CONTROL_RESPONSE_METHODS: &[&str] = &[${schema.controlResponseMethods.map(value => JSON.stringify(value)).join(", ")}];\npub(crate) const KERNEL_INPUT_ORDER_PARAMS: &[(&str,&str)] = &[${Object.entries(schema.inputOrderParams).map(([method,field]) => `(${JSON.stringify(method)},${JSON.stringify(field)})`).join(", ")}];\npub(crate) const KERNEL_RUNTIME_DATA_METHODS: &[&str] = &[${(schema.runtimeDataMethods ?? []).map(value => JSON.stringify(value)).join(", ")}];\n\n#[derive(Clone, Debug, Deserialize)]\n#[serde(transparent)]\npub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);\n\n${[...rustDtoNames].map(renderRustDto).join('\n\n')}\n\npub(crate) fn validate_generated_method_params(method: &str, params: &Value) -> Result<(), String> {\n    match method {\n${Object.entries(methodParams).map(([method, paramsType]) => `        ${JSON.stringify(method)} => serde_json::from_value::<${paramsType}>(params.clone()).map(|_| ()).map_err(|error| error.to_string()),`).join('\n')}\n        _ => Ok(()),\n    }\n}\n\npub(crate) fn validate_generated_working_document(record_type: &str, document: &Value) -> Result<(), String> {\n    match record_type {\n${Object.entries(workingDocumentDto).map(([recordType, dto]) => `        ${JSON.stringify(recordType)} => serde_json::from_value::<${dto}>(document.clone()).map(|_| ()).map_err(|error| error.to_string()),`).join('\n')}\n        _ => Ok(()),\n    }\n}\n`;
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
  if (existing !== generated || existingRust !== rustGenerated || existingTypes !== runtimeTypesGenerated || existingProtocol !== protocolGenerated) {
    const stale = [existing !== generated ? target : null, existingRust !== rustGenerated ? rustTarget : null, existingTypes !== runtimeTypesGenerated ? runtimeTypesTarget : null, existingProtocol !== protocolGenerated ? protocolTarget : null].filter(Boolean);
    console.error(`Kernel protocol DTO is out of date: ${stale.map((entry) => path.relative(root, entry)).join(', ')}`);
    process.exit(1);
  }
  console.log(`Kernel protocol ${schema.protocolVersion} is up to date.`);
} else {
  fs.writeFileSync(protocolTarget, protocolGenerated);
  fs.writeFileSync(target, generated);
  fs.writeFileSync(rustTarget, rustGenerated);
  fs.writeFileSync(runtimeTypesTarget, runtimeTypesGenerated);
  console.log(`Kernel protocol ${schema.protocolVersion} is generated at ${path.relative(root, target)}`);
}
