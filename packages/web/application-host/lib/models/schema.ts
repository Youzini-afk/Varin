/** JSON Schema compiler shared by trusted Host tool boundaries. No runtime, owner or permission state. */
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
const annotationsByValidator = new WeakMap<ValidateFunction, readonly string[]>();
const diagnosticValidators = new WeakMap<ValidateFunction, ValidateFunction>();

/** Compile without coercion, defaults, property removal, external loading or asynchronous execution. */
export function compileToolJsonSchema(input: unknown, annotations: readonly string[] = []): ValidateFunction {
  return compile(input, annotations, false);
}

function compile(input: unknown, annotations: readonly string[], allErrors: boolean): ValidateFunction {
  if (typeof input !== 'boolean' && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('tool_schema_invalid');
  }
  const schema = structuredClone(input) as boolean | Record<string, unknown>;
  if (typeof schema === 'object' && schema.$async === true) throw new Error('tool_schema_async_unsupported');
  const dialect = typeof schema === 'object' && typeof schema.$schema === 'string' ? schema.$schema : undefined;
  const options = { allErrors, strictSchema: true, strictTypes: false, allowUnionTypes: true,
    ownProperties: true, logger: false, coerceTypes: false, useDefaults: false, removeAdditional: false } as const;
  const ajv = dialect?.includes('draft-07') ? new Ajv(options)
    : dialect?.includes('2019-09') ? new Ajv2019(options) : new Ajv2020(options);
  // Protocol owners validate annotation semantics; these never relax JSON value constraints.
  for (const keyword of annotations) ajv.addKeyword({ keyword, valid: true });
  // ajv-formats is CommonJS and publishes its callable on the explicit default export.
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  if ('$async' in validate && validate.$async === true) throw new Error('tool_schema_async_unsupported');
  annotationsByValidator.set(validate, annotations);
  return validate;
}

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema => value && typeof value === 'object' && !Array.isArray(value) ? value as Schema : {};
const pointer = (root: unknown, path: string): unknown => path.replace(/^#/, '').split('/').slice(1)
  .reduce<unknown>((value, key) => Array.isArray(value) ? value[Number(key)]
    : object(value)[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
const childPath = (path: string, key: string) => `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Pure failure diagnostics, compiled lazily. Successful calls retain fast validation.
 * Only schema-authored values and field paths appear here, never submitted values. */
export function describeToolSchemaFailure(validate: ValidateFunction, input: unknown): string {
  let diagnostic = diagnosticValidators.get(validate);
  if (!diagnostic) {
    diagnostic = compile(validate.schema, annotationsByValidator.get(validate) ?? [], true);
    diagnosticValidators.set(validate, diagnostic);
  }
  diagnostic(input);
  const errors = diagnostic.errors ?? [];
  const suppressed: { schema: string; instance: string }[] = [];
  const hidden = new Set<typeof errors[number]>();
  const choices: string[] = [];
  const resolve = (value: unknown): Schema => {
    const node = object(value);
    return typeof node.$ref === 'string' && node.$ref.startsWith('#/') ? object(pointer(validate.schema, node.$ref)) : node;
  };
  const excluded = (path: string, instance: string) => suppressed.some(prefix =>
    (instance === prefix.instance || instance.startsWith(`${prefix.instance}/`))
    && (path === prefix.schema || path.startsWith(`${prefix.schema}/`)));
  for (const issue of errors.filter(error => error.keyword === 'oneOf' || error.keyword === 'anyOf')
    .sort((a, b) => a.schemaPath.length - b.schemaPath.length)) {
    if (excluded(issue.schemaPath, issue.instancePath)) continue;
    const branches = pointer(validate.schema, issue.schemaPath);
    if (!Array.isArray(branches)) continue;
    const value = object(pointer(input, issue.instancePath));
    const possible = branches.map((branch, index) => ({ schema: resolve(branch), index })).filter(({ schema }) =>
      Object.entries(object(schema.properties)).every(([key, rule]) => {
        if (!Object.hasOwn(value, key)) return true;
        const field = resolve(rule);
        return (!Object.hasOwn(field, 'const') || field.const === value[key])
          && (!Array.isArray(field.enum) || field.enum.includes(value[key]));
      }));
    hidden.add(issue);
    if (possible.length === 1) {
      for (let index = 0; index < branches.length; index++) if (index !== possible[0]!.index) suppressed.push({ schema: `${issue.schemaPath}/${index}`, instance: issue.instancePath });
      continue;
    }
    suppressed.push({ schema: issue.schemaPath, instance: issue.instancePath });
    const alternatives = (possible.length ? possible : branches.map((branch, index) => ({ schema: resolve(branch), index })))
      .map(({ schema }) => {
        const discriminators = Object.entries(object(schema.properties)).flatMap(([key, rule]) => {
          const field = resolve(rule);
          return Object.hasOwn(field, 'const') ? [`${key}=${JSON.stringify(field.const)}`] : [];
        });
        const required = Array.isArray(schema.required) ? schema.required.filter(key => typeof key === 'string'
          && !discriminators.some(label => label.startsWith(`${key}=`))) : [];
        return [...discriminators, ...(required.length ? [`requires ${required.join(', ')}`] : [])].join('; ')
          || (typeof schema.type === 'string' ? schema.type : Array.isArray(schema.enum) ? `one of ${JSON.stringify(schema.enum)}` : 'a schema alternative');
      });
    choices.push(`at ${issue.instancePath || '/'}: choose ${issue.keyword === 'oneOf' ? 'exactly one' : 'at least one'} valid form: ${[...new Set(alternatives)].join(' OR ')}`);
  }
  const messages = errors.filter(issue => !hidden.has(issue) && !excluded(issue.schemaPath, issue.instancePath)).map(issue => {
    const missing = issue.keyword === 'required' ? String(issue.params.missingProperty) : undefined;
    const extra = issue.keyword === 'additionalProperties' ? String(issue.params.additionalProperty) : undefined;
    const path = missing || extra ? childPath(issue.instancePath, missing ?? extra!) : issue.instancePath || '/';
    const parent = resolve(pointer(validate.schema, issue.schemaPath.slice(0, issue.schemaPath.lastIndexOf('/'))));
    const field = missing ? resolve(object(parent.properties)[missing]) : {};
    const description = typeof field.description === 'string' ? ` (${field.description})` : '';
    return `at ${path}: ${missing ? 'required' : extra ? 'unknown field' : issue.message ?? 'schema validation failed'}${description}`;
  });
  return [...new Set([...messages, ...choices])].join('; ') || 'arguments do not match the tool schema';
}
