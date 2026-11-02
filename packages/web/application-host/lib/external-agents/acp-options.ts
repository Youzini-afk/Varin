import type {
  ExternalAgentCapabilities,
  ExternalInput,
} from '@varin/application-client';
import { record, text, type RecordValue } from './transport.js';

type ConfigOption = NonNullable<
  ExternalAgentCapabilities['configOptions']
>[number];

function grokEfforts(meta: RecordValue): string[] {
  if (
    meta.supportsReasoningEffort !== true ||
    !Array.isArray(meta.reasoningEfforts)
  )
    return [];
  return meta.reasoningEfforts.flatMap((value) => {
    const id =
      typeof value === 'string'
        ? value
        : text(record(value).id) || text(record(value).value);
    return id ? [id] : [];
  });
}

function choices(value: unknown): ConfigOption['options'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    if (Array.isArray(row.options)) return choices(row.options);
    if (typeof row.value !== 'string' || typeof row.name !== 'string')
      return [];
    return [
      {
        value: row.value,
        name: row.name,
        ...(typeof row.description === 'string'
          ? { description: row.description }
          : {}),
      },
    ];
  });
}

export function readAcpConfigOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    if (!text(row.id) || typeof row.name !== 'string') return [];
    if (row.type !== 'select' && row.type !== 'boolean') return [];
    if (row.type === 'select' && typeof row.currentValue !== 'string')
      return [];
    if (row.type === 'boolean' && typeof row.currentValue !== 'boolean')
      return [];
    return [
      {
        id: text(row.id),
        name: row.name,
        type: row.type,
        ...(typeof row.category === 'string' ? { category: row.category } : {}),
        currentValue: row.currentValue as string | boolean,
        options: row.type === 'select' ? choices(row.options) : [],
      },
    ];
  });
}

export class AcpOptions {
  private legacyModels: ExternalAgentCapabilities['models'] = [];
  private legacyModel: string | undefined;
  private legacyModes: NonNullable<ExternalAgentCapabilities['modes']> = [];
  private legacyMode: string | undefined;
  private grokThinking: string | undefined;
  private grokEfforts = new Map<string, string[]>();
  constructor(
    readonly capabilities: ExternalAgentCapabilities,
    private readonly changed: () => void,
    private readonly dialect?: 'grok',
  ) {}

  // Connection-level catalog defaults are not the current session's model/effort.
  catalog(value: unknown): void {
    const models = record(value);
    if (this.dialect !== 'grok' || !Array.isArray(models.availableModels))
      return;
    const entries = models.availableModels
      .map(record)
      .filter((row) => text(row.modelId));
    if (!entries.length) return;
    this.legacyModels = entries.map((row) => ({
      id: text(row.modelId),
      name: text(row.name) || text(row.modelId),
    }));
    this.grokEfforts.clear();
    for (const row of entries)
      this.grokEfforts.set(text(row.modelId), grokEfforts(record(row._meta)));
    this.publish();
  }

  adopt(value: RecordValue): void {
    if (Array.isArray(value.configOptions))
      this.capabilities.configOptions = readAcpConfigOptions(
        value.configOptions,
      );
    if (Object.hasOwn(value, 'models')) {
      const models = record(value.models);
      if (this.dialect === 'grok') {
        this.grokEfforts.clear();
        this.grokThinking = undefined;
      }
      this.legacyModels = (
        Array.isArray(models.availableModels) ? models.availableModels : []
      ).flatMap((entry) => {
        const row = record(entry);
        if (this.dialect === 'grok') {
          const meta = record(row._meta);
          const efforts = grokEfforts(meta);
          this.grokEfforts.set(text(row.modelId), efforts);
          if (
            row.modelId === models.currentModelId &&
            meta.supportsReasoningEffort === true
          ) {
            const mapped = (
              Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []
            ).find((entry) => record(entry).value === meta.reasoningEffort);
            this.grokThinking =
              text(record(mapped).id) ||
              text(meta.reasoningEffort) ||
              undefined;
          }
        }
        return text(row.modelId)
          ? [
              {
                id: text(row.modelId),
                name: text(row.name) || text(row.modelId),
              },
            ]
          : [];
      });
      this.legacyModel = text(models.currentModelId) || undefined;
    }
    if (this.dialect === 'grok') {
      const config = record(record(value._meta)['x.ai/sessionConfig']);
      if (Array.isArray(config.options)) {
        const rows = config.options.map(record),
          models = rows.filter(
            (row) => row.category === 'model' && text(row.id),
          );
        if (!Object.hasOwn(value, 'models') && models.length) {
          this.legacyModels = models.map((row) => ({
            id: text(row.id),
            name: text(row.label) || text(row.id),
          }));
          this.legacyModel =
            text(models.find((row) => row.selected === true)?.id) || undefined;
        }
        const efforts = rows.filter(
          (row) => row.category === 'mode' && text(row.id),
        );
        if (
          this.legacyModel &&
          efforts.length &&
          !this.grokEfforts.get(this.legacyModel)?.length
        )
          this.grokEfforts.set(
            this.legacyModel,
            efforts.map((row) => text(row.id)),
          );
        this.grokThinking =
          text(efforts.find((row) => row.selected === true)?.id) ||
          this.grokThinking;
      }
    }
    if (Object.hasOwn(value, 'modes')) {
      const modes = record(value.modes);
      this.legacyModes = (
        Array.isArray(modes.availableModes) ? modes.availableModes : []
      ).flatMap((entry) => {
        const row = record(entry);
        return text(row.id)
          ? [{ id: text(row.id), name: text(row.name) || text(row.id) }]
          : [];
      });
      this.legacyMode = text(modes.currentModeId) || undefined;
    }
    this.publish();
  }

  update(update: RecordValue): void {
    if (update.sessionUpdate === 'config_option_update')
      this.adopt({ configOptions: update.configOptions });
    else if (update.sessionUpdate === 'current_mode_update') {
      this.legacyMode = text(update.currentModeId) || undefined;
      this.publish();
    } else if (update.sessionUpdate === 'available_commands_update') {
      this.capabilities.commands = (
        Array.isArray(update.availableCommands) ? update.availableCommands : []
      ).flatMap((entry) => {
        const row = record(entry);
        return text(row.name)
          ? [
              {
                name: text(row.name),
                description: text(row.description),
                ...(typeof record(row.input).hint === 'string'
                  ? { inputHint: text(record(row.input).hint) }
                  : {}),
              },
            ]
          : [];
      });
      this.changed();
    }
  }

  private category(category: string): ConfigOption | undefined {
    return this.capabilities.configOptions?.find(
      (option) => option.category === category && option.type !== 'boolean',
    );
  }

  private publish(): void {
    const model = this.category('model'),
      thinking = this.category('thought_level'),
      mode = this.category('mode');
    this.capabilities.models = model
      ? model.options.map((option) => ({ id: option.value, name: option.name }))
      : this.legacyModels;
    if (thinking)
      this.capabilities.models = this.capabilities.models.map((entry) => ({
        ...entry,
        ...(entry.id === (model?.currentValue ?? this.legacyModel)
          ? { thinkingLevels: thinking.options.map((option) => option.value) }
          : {}),
      }));
    else if (this.dialect === 'grok')
      this.capabilities.models = this.capabilities.models.map((entry) => ({
        ...entry,
        thinkingLevels: this.grokEfforts.get(entry.id) ?? [],
      }));
    this.capabilities.modes = mode
      ? mode.options.map((option) => ({ id: option.value, name: option.name }))
      : this.legacyModes;
    this.capabilities.current = {
      ...(typeof model?.currentValue === 'string' || this.legacyModel
        ? {
            model:
              typeof model?.currentValue === 'string'
                ? model.currentValue
                : this.legacyModel!,
          }
        : {}),
      ...(typeof thinking?.currentValue === 'string' || this.grokThinking
        ? {
            thinking:
              typeof thinking?.currentValue === 'string'
                ? thinking.currentValue
                : this.grokThinking!,
          }
        : {}),
      ...(typeof mode?.currentValue === 'string' || this.legacyMode
        ? {
            mode:
              typeof mode?.currentValue === 'string'
                ? mode.currentValue
                : this.legacyMode!,
          }
        : {}),
    };
    this.changed();
  }

  async apply(
    input: ExternalInput,
    request: (method: string, params: RecordValue) => Promise<RecordValue>,
    sessionId: string,
    cancelled: () => boolean,
  ): Promise<void> {
    const generic = new Map(Object.entries(input.config ?? {}));
    const validate = (id: string, value: string): ConfigOption => {
      const option = this.capabilities.configOptions?.find(
        (entry) => entry.id === id,
      );
      if (!option) throw new Error(`ACP session does not offer option ${id}`);
      if (
        option.type === 'boolean'
          ? value !== 'true' && value !== 'false'
          : !option.options.some((entry) => entry.value === value)
      )
        throw new Error(
          `ACP session does not offer the requested value for ${option.name}`,
        );
      return option;
    };
    const setOption = async (id: string, value: string) => {
      const option = validate(id, value);
      const wire = option.type === 'boolean' ? value === 'true' : value;
      const response = await request('session/set_config_option', {
        sessionId,
        configId: id,
        value: wire,
      });
      if (!Array.isArray(response.configOptions))
        throw new Error('ACP Agent did not confirm its updated options');
      this.adopt(response);
      if (
        this.capabilities.configOptions?.find((entry) => entry.id === id)
          ?.currentValue !== wire
      )
        throw new Error(`ACP Agent did not apply option ${option.name}`);
    };

    // The current session's effort menu need not describe the requested model.
    // Apply/confirm the model first, then resolve dependent categories and IDs anew.
    const modelOption = this.category('model');
    const model =
      input.model ?? (modelOption ? generic.get(modelOption.id) : undefined);
    if (
      modelOption &&
      input.model !== undefined &&
      generic.has(modelOption.id) &&
      generic.get(modelOption.id) !== input.model
    )
      throw new Error(`Conflicting ACP option: ${modelOption.name}`);
    if (model !== undefined) {
      if (cancelled()) return;
      if (modelOption) {
        generic.delete(modelOption.id);
        await setOption(modelOption.id, model);
      } else {
        if (!this.legacyModels.some((entry) => entry.id === model))
          throw new Error('ACP session does not offer the requested model');
        const response = await request('session/set_model', {
          sessionId,
          modelId: model,
        });
        if (this.legacyModel !== model) this.grokThinking = undefined;
        this.legacyModel = model;
        this.adopt(response);
      }
    }
    if (cancelled()) return;
    const writes = new Map<string, string>();
    for (const [category, value] of [
      ['thought_level', input.thinking],
      ['mode', input.mode],
    ] as const) {
      if (value === undefined) continue;
      const option = this.category(category);
      if (option) {
        if (generic.has(option.id) && generic.get(option.id) !== value)
          throw new Error(`Conflicting ACP option: ${option.name}`);
        writes.set(option.id, value);
      } else if (category === 'thought_level' && this.dialect !== 'grok')
        throw new Error('This ACP session does not offer a thinking option');
    }
    for (const [id, value] of generic) writes.set(id, value);
    for (const [id, value] of writes) validate(id, value);
    const legacyMode = input.mode !== undefined && !this.category('mode');
    const legacyThinking =
      input.thinking !== undefined && !this.category('thought_level');
    if (
      legacyMode &&
      !this.legacyModes.some((entry) => entry.id === input.mode)
    )
      throw new Error('ACP session does not offer the requested mode');
    if (
      legacyThinking &&
      !this.grokEfforts.get(this.legacyModel ?? '')?.includes(input.thinking!)
    )
      throw new Error(
        'ACP session does not offer the requested thinking level',
      );
    for (const [id, value] of writes) {
      if (cancelled()) return;
      await setOption(id, value);
    }
    if (legacyThinking && !cancelled()) {
      if (!this.legacyModel)
        throw new Error('ACP session did not report its current model');
      await request('session/set_model', {
        sessionId,
        modelId: this.legacyModel,
        _meta: { reasoningEffort: input.thinking },
      });
      this.grokThinking = input.thinking;
      this.publish();
    }
    if (legacyMode && !cancelled()) {
      await request('session/set_mode', { sessionId, modeId: input.mode });
      this.legacyMode = input.mode;
      this.publish();
    }
  }
}
