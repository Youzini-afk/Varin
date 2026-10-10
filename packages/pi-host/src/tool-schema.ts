/** JSON Schema compiler shared by trusted Host tool boundaries. No runtime, owner or permission state. */
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';

/** Compile without coercion, defaults, property removal, external loading or asynchronous execution. */
export function compileToolJsonSchema(input: unknown): ValidateFunction {
  if (typeof input !== 'boolean' && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('tool_schema_invalid');
  }
  const schema = structuredClone(input) as boolean | Record<string, unknown>;
  if (typeof schema === 'object' && schema.$async === true) throw new Error('tool_schema_async_unsupported');
  const dialect = typeof schema === 'object' && typeof schema.$schema === 'string' ? schema.$schema : undefined;
  const options = { allErrors: false, strictSchema: true, strictTypes: false, allowUnionTypes: true,
    ownProperties: true, logger: false, coerceTypes: false, useDefaults: false, removeAdditional: false } as const;
  const ajv = dialect?.includes('draft-07') ? new Ajv(options)
    : dialect?.includes('2019-09') ? new Ajv2019(options) : new Ajv2020(options);
  // ajv-formats is CommonJS and publishes its callable on the explicit default export.
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  if ('$async' in validate && validate.$async === true) throw new Error('tool_schema_async_unsupported');
  return validate;
}
