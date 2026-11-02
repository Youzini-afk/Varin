import { isExternalInteractionValueValid } from '@varin/application-client';
import type {
  ExternalInteraction,
  ExternalInteractionField,
  ExternalInteractionResponse,
} from '@varin/application-client';
import { record, text, type RecordValue } from './transport.js';

export type FormResult =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' | 'cancel' };
export interface FormInteraction {
  request: Omit<ExternalInteraction, 'turnId'>;
  reply(response: ExternalInteractionResponse): FormResult;
  cancelled: { action: 'cancel' };
}

function enumOptions(
  schema: RecordValue,
): Array<{ value: string; label: string }> | undefined {
  if (
    [schema.enum, schema.oneOf, schema.anyOf].filter(
      (value) => value !== undefined,
    ).length !== 1
  )
    return undefined;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.every((value) => typeof value === 'string')
  ) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    if (
      !schema.enum.length ||
      (schema.enumNames !== undefined &&
        (names.length !== schema.enum.length ||
          names.some((name) => typeof name !== 'string')))
    )
      return undefined;
    return schema.enum.map((value, index) => ({
      value: String(value),
      label: text(names[index]) || String(value),
    }));
  }
  const rows = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(rows) || !rows.length) return undefined;
  if (
    rows.some((entry) => {
      const row = record(entry);
      return (
        typeof row.const !== 'string' ||
        (row.type !== undefined && row.type !== 'string') ||
        Object.keys(row).some(
          (key) =>
            !['const', 'title', 'description', 'type', '_meta'].includes(key),
        )
      );
    })
  )
    return undefined;
  return rows.map((entry) => ({
    value: text(record(entry).const),
    label: text(record(entry).title) || text(record(entry).const),
  }));
}

// Only primitive form fields are advertised; unsupported schema forms are declined, never guessed.
export function formInteraction(
  id: string,
  params: RecordValue,
): FormInteraction | undefined {
  if (params.mode !== undefined && params.mode !== 'form') return undefined;
  const schema = record(params.requestedSchema);
  if (
    schema.type !== 'object' ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  )
    return undefined;
  if (
    Object.keys(schema).some(
      (key) =>
        ![
          'type',
          'title',
          'description',
          'properties',
          'required',
          'additionalProperties',
          '_meta',
          '$schema',
        ].includes(key),
    )
  )
    return undefined;
  if (schema.required !== undefined && !Array.isArray(schema.required))
    return undefined;
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  )
    return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = Object.entries(record(schema.properties));
  if (
    required.some(
      (id) =>
        typeof id !== 'string' || !Object.hasOwn(record(schema.properties), id),
    )
  )
    return undefined;
  const fields: ExternalInteractionField[] = [];
  const checks = new Map<string, (value: unknown) => boolean>();
  for (const [key, raw] of properties) {
    const property = record(raw);
    if (
      Object.keys(property).some(
        (name) =>
          ![
            'type',
            'title',
            'description',
            'default',
            'enum',
            'enumNames',
            'oneOf',
            'anyOf',
            'items',
            'minLength',
            'maxLength',
            'minimum',
            'maximum',
            'minItems',
            'maxItems',
            'uniqueItems',
            'format',
            '_meta',
          ].includes(name),
      )
    )
      return undefined;
    if (property.format !== undefined) return undefined;
    const multi = property.type === 'array';
    if (multi) {
      const items = record(property.items);
      if (items.type !== undefined && items.type !== 'string') return undefined;
      if (
        Object.keys(items).some(
          (key) =>
            ![
              'type',
              'enum',
              'enumNames',
              'oneOf',
              'anyOf',
              'title',
              'description',
              '_meta',
            ].includes(key),
        )
      )
        return undefined;
      if (
        property.uniqueItems !== undefined &&
        typeof property.uniqueItems !== 'boolean'
      )
        return undefined;
    }
    const options = enumOptions(multi ? record(property.items) : property);
    if (
      !multi &&
      (property.enum !== undefined ||
        property.oneOf !== undefined ||
        property.anyOf !== undefined) &&
      !options
    )
      return undefined;
    if (
      options &&
      property.type !== undefined &&
      property.type !== 'string' &&
      !multi
    )
      return undefined;
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (
        property[key] !== undefined &&
        (typeof property[key] !== 'number' ||
          !Number.isSafeInteger(property[key]) ||
          (property[key] as number) < 0)
      )
        return undefined;
    }
    for (const key of ['minimum', 'maximum']) {
      if (
        property[key] !== undefined &&
        (typeof property[key] !== 'number' || !Number.isFinite(property[key]))
      )
        return undefined;
    }
    let type: ExternalInteractionField['type'];
    if (multi && options) type = 'multiselect';
    else if (
      (property.type === 'string' || property.type === undefined) &&
      options
    )
      type = 'select';
    else if (
      property.type === 'string' &&
      !property.enum &&
      !property.oneOf &&
      !property.anyOf
    )
      type = 'text';
    else if (property.type === 'number' || property.type === 'integer')
      type = 'number';
    else if (property.type === 'boolean') type = 'boolean';
    else return undefined;
    const field: ExternalInteractionField = {
      id: key,
      label: text(property.title) || key,
      type,
      required: required.includes(key),
      ...(typeof property.description === 'string'
        ? { description: property.description }
        : {}),
      ...(options ? { options } : {}),
      ...(property.type === 'integer' ? { integer: true } : {}),
      ...Object.fromEntries(
        ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']
          .filter((key) => typeof property[key] === 'number')
          .map((key) => [key, property[key]]),
      ),
    };
    const valid = (value: unknown) =>
      isExternalInteractionValueValid(field, value);
    checks.set(key, valid);
    if (property.default !== undefined && valid(property.default))
      field.defaultValue = property.default as NonNullable<
        ExternalInteractionField['defaultValue']
      >;
    fields.push(field);
  }
  return {
    request: {
      id,
      kind: 'question',
      title: text(schema.title) || 'Agent question',
      detail: text(params.message),
      options: [],
      fields,
    },
    cancelled: { action: 'cancel' },
    reply(response) {
      if (response.cancelled) return { action: 'cancel' };
      const content: Record<string, unknown> = Object.create(null);
      for (const field of fields) {
        const value = response.values?.[field.id];
        if (value === undefined && !field.required) continue;
        if (!checks.get(field.id)!(value)) return { action: 'decline' };
        content[field.id] = value;
      }
      if (Object.keys(response.values ?? {}).some((id) => !checks.has(id)))
        return { action: 'decline' };
      return { action: 'accept', content };
    },
  };
}
