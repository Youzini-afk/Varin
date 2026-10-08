import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'kernel', 'protocol', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const target = path.join(root, 'packages', 'web', 'application-host', 'lib', 'kernel', 'protocol.generated.ts');
const rustTarget = path.join(root, 'kernel', 'crates', 'varin-kernel', 'src', 'protocol_generated.rs');
const nativeProtocolTarget = path.join(root, 'packages', 'protocol', 'src', 'native-runtime.generated.ts');
const nativeRustTarget = path.join(root, 'kernel', 'crates', 'varin-runtime', 'src', 'types_generated.rs');
const nativeStructs = Object.entries(schema.nativeRuntimeStructs ?? {}).map(([name, spec]) => {
  const fields = Object.entries(spec.fields).map(([key, value]) => {
    let type = ({string:"String", number:"u64", boolean:"bool", "string | null":"Option<String>", "number | null":"Option<u64>"})[value.type];
    if (value.optional && type && !type.startsWith("Option<")) type = `Option<${type}>`;
    if (!type) throw new Error(`Unsupported native field type ${value.type}`);
    const field = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return `    pub ${field}: ${type},`;
  });
  return `#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct ${name} {\n${fields.join("\n")}\n}\n`;
}).join("\n");
const nativeRustGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\nuse serde::{Deserialize, Serialize};\n\n' + Object.entries(schema.nativeRuntimeEnums ?? {}).map(([name, variants]) => `#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]\n#[serde(rename_all = "snake_case")]\npub enum ${name} {\n${variants.map(v => `    ${v},`).join('\n')}\n}\n`).join('\n') + '\n' + nativeStructs;
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
const nativeProtocolGenerated = '// Generated from kernel/protocol/schema.json. Do not hand-edit.\n\n' + dtoEntries.filter(([name]) => name.startsWith('Native')).map(([name, spec]) => renderDto(name, spec)).join('\n\n') + '\n';
const generated = `/**
 * Generated from \`kernel/protocol/schema.json\`.
 * Do not hand-edit the wire shapes; run \`node scripts/generate-kernel-protocol.mjs\`.
 */

export const KERNEL_PROTOCOL_VERSION = ${schema.protocolVersion} as const;
export const KERNEL_REQUEST_WINDOW = ${schema.requestWindow} as const;
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
  if (type.startsWith("Native") && schema.nativeRuntimeEnums?.[type.slice(6)]) return `varin_runtime::${type.slice(6)}`;
  if (type.endsWith('[]')) return `Vec<${rustType(type.slice(0, -2))}>`;
  if (type === 'string') return 'String';
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
      if (schema.dto?.[bare] && !schema.dto[bare].raw && !rustDtoNames.has(bare)) {
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
    return `    pub(crate) ${snakeCase(field)}: ${rendered},`;
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
const unformattedRust = `// Generated from kernel/protocol/schema.json. Do not hand-edit.\n#![allow(dead_code)]\n\nuse crate::model::PathState;\nuse serde::Deserialize;\nuse serde_json::Value;\n\npub(crate) const KERNEL_REQUEST_WINDOW: usize = ${schema.requestWindow};\n\n#[derive(Clone, Debug, Deserialize)]\n#[serde(transparent)]\npub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);\n\n${[...rustDtoNames].map(renderRustDto).join('\n\n')}\n\npub(crate) fn validate_generated_method_params(method: &str, params: &Value) -> Result<(), String> {\n    match method {\n${Object.entries(methodParams).map(([method, paramsType]) => `        ${JSON.stringify(method)} => serde_json::from_value::<${paramsType}>(params.clone()).map(|_| ()).map_err(|error| error.to_string()),`).join('\n')}\n        _ => Ok(()),\n    }\n}\n\npub(crate) fn validate_generated_working_document(record_type: &str, document: &Value) -> Result<(), String> {\n    match record_type {\n${Object.entries(workingDocumentDto).map(([recordType, dto]) => `        ${JSON.stringify(recordType)} => serde_json::from_value::<${dto}>(document.clone()).map(|_| ()).map_err(|error| error.to_string()),`).join('\n')}\n        _ => Ok(()),\n    }\n}\n`;
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
  const existingNative = fs.existsSync(nativeRustTarget) ? fs.readFileSync(nativeRustTarget, "utf8") : "";
  const existingNativeProtocol = fs.existsSync(nativeProtocolTarget) ? fs.readFileSync(nativeProtocolTarget, 'utf8') : '';
  if (existing !== generated || existingRust !== rustGenerated || existingNative !== nativeRustGenerated || existingNativeProtocol !== nativeProtocolGenerated) {
    const stale = [existing !== generated ? target : null, existingRust !== rustGenerated ? rustTarget : null, existingNative !== nativeRustGenerated ? nativeRustTarget : null, existingNativeProtocol !== nativeProtocolGenerated ? nativeProtocolTarget : null].filter(Boolean);
    console.error(`Kernel protocol DTO is out of date: ${stale.map((entry) => path.relative(root, entry)).join(', ')}`);
    process.exit(1);
  }
  console.log(`Kernel protocol ${schema.protocolVersion} is up to date.`);
} else {
  fs.writeFileSync(nativeProtocolTarget, nativeProtocolGenerated);
  fs.writeFileSync(target, generated);
  fs.writeFileSync(rustTarget, rustGenerated);
  fs.writeFileSync(nativeRustTarget, nativeRustGenerated);
  console.log(`Kernel protocol ${schema.protocolVersion} is generated at ${path.relative(root, target)}`);
}
