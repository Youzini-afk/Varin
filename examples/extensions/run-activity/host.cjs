var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// examples/extensions/run-activity/host.ts
var host_exports = {};
__export(host_exports, {
  default: () => host_default
});
module.exports = __toCommonJS(host_exports);

// packages/extension-contract/src/run-activity.ts
var VARIN_RUN_ACTIVITY_SERVICE_ID = "varin.run.activity";
var VARIN_RUN_ACTIVITY_VERSION = 1;
var VARIN_RUN_ACTIVITY_KINDS = ["run.accepted", "run.changed", "run.cancel_requested"];
var VARIN_RUN_ACTIVITY_STATES = ["accepted", "preparing", "runnable", "generating", "executing", "waiting", "completed", "failed", "cancelled"];
var identitySchema = { type: "string", minLength: 1 };
var cursorSchema = { type: "integer", minimum: 1 };
var VARIN_RUN_ACTIVITY_DELIVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subscriptionId", "threadId", "deliveryId", "fact"],
  properties: {
    subscriptionId: identitySchema,
    threadId: identitySchema,
    deliveryId: identitySchema,
    fact: {
      type: "object",
      additionalProperties: false,
      required: ["cursor", "subject", "revision", "kind", "data"],
      properties: {
        cursor: cursorSchema,
        subject: identitySchema,
        revision: cursorSchema,
        kind: { enum: VARIN_RUN_ACTIVITY_KINDS },
        data: {
          type: "object",
          additionalProperties: false,
          required: ["state"],
          properties: { state: { enum: [...VARIN_RUN_ACTIVITY_STATES, null] } }
        }
      }
    }
  }
};
var VARIN_RUN_ACTIVITY_ACKNOWLEDGEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subscriptionId", "deliveryId", "cursor"],
  properties: { subscriptionId: identitySchema, deliveryId: identitySchema, cursor: cursorSchema }
};
var VARIN_RUN_ACTIVITY_CONTRACT = {
  id: VARIN_RUN_ACTIVITY_SERVICE_ID,
  version: VARIN_RUN_ACTIVITY_VERSION,
  participation: "observer",
  delivery: "at-least-once",
  methods: {
    observe: {
      inputSchema: { type: "array", minItems: 1, maxItems: 1, items: VARIN_RUN_ACTIVITY_DELIVERY_SCHEMA },
      outputSchema: VARIN_RUN_ACTIVITY_ACKNOWLEDGEMENT_SCHEMA
    },
    getSnapshot: { input: "subscriptionId", output: "{ subscriptionId, cursor, projection } | null" },
    inspect: { input: "none", output: "contract" }
  },
  factKinds: VARIN_RUN_ACTIVITY_KINDS,
  deduplication: ["subscriptionId", "fact.cursor"],
  effects: "Projection only. Business work requires a new, authorized command with observer provenance and an idempotency key."
};
var record = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run activity requires an object");
  return value;
};
var fields = (value, names) => {
  if (Object.keys(value).some((key) => !names.includes(key))) throw new Error("Unknown Run activity field");
};
var text = (value) => {
  if (typeof value !== "string" || !value.trim()) throw new Error("Run activity identity must be nonempty");
  return value;
};
var number = (value) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Run activity cursor/revision must be a positive safe integer");
  return Number(value);
};
function parseVarinRunActivityDelivery(value) {
  const raw = record(value), fact = record(raw.fact), data = record(fact.data);
  fields(raw, ["subscriptionId", "threadId", "deliveryId", "fact"]);
  fields(fact, ["cursor", "subject", "revision", "kind", "data"]);
  fields(data, ["state"]);
  if (!VARIN_RUN_ACTIVITY_KINDS.includes(fact.kind) || data.state !== null && !VARIN_RUN_ACTIVITY_STATES.includes(data.state)) {
    throw new Error("Unsupported Run activity fact");
  }
  return Object.freeze({
    subscriptionId: text(raw.subscriptionId),
    threadId: text(raw.threadId),
    deliveryId: text(raw.deliveryId),
    fact: Object.freeze({
      cursor: number(fact.cursor),
      subject: text(fact.subject),
      revision: number(fact.revision),
      kind: fact.kind,
      data: Object.freeze({ state: data.state })
    })
  });
}

// packages/extension-sdk/dist/run-activity.js
function provideRunActivityProjection(context, reduce) {
  const tails = /* @__PURE__ */ new Map();
  const open = (subscriptionId) => context.storage.open({ scope: "application", key: `run-activity:${subscriptionId}`, schemaVersion: 1 });
  context.services.provide({ id: VARIN_RUN_ACTIVITY_SERVICE_ID, version: VARIN_RUN_ACTIVITY_VERSION, multiple: true }, {
    inspect: (args) => {
      if (args.length)
        throw new Error("Activity inspect takes no arguments");
      return JSON.parse(JSON.stringify(VARIN_RUN_ACTIVITY_CONTRACT));
    },
    getSnapshot: async (args) => {
      if (args.length !== 1 || typeof args[0] !== "string" || !args[0].trim())
        throw new Error("Activity snapshot requires a subscription ID");
      const snapshot = await (await open(args[0])).refresh();
      if (!snapshot.authoritative)
        throw new Error("Activity projection storage is unavailable");
      return snapshot.exists ? snapshot.document.data : null;
    },
    observe: (args, call) => {
      if (args.length !== 1)
        throw new Error("Activity observe requires one delivery");
      const delivery = parseVarinRunActivityDelivery(args[0]);
      const previous = tails.get(delivery.subscriptionId) ?? Promise.resolve();
      const pending = previous.catch(() => {
      }).then(async () => {
        call.signal.throwIfAborted();
        const document = await open(delivery.subscriptionId);
        const snapshot = await document.refresh();
        if (!snapshot.authoritative)
          throw new Error("Activity projection storage is unavailable");
        const saved = snapshot.document.data;
        if (snapshot.exists && (saved.subscriptionId !== delivery.subscriptionId || !Number.isSafeInteger(saved.cursor) || Number(saved.cursor) < 1 || !saved.projection || typeof saved.projection !== "object" || Array.isArray(saved.projection))) {
          throw new Error("Activity projection checkpoint is invalid");
        }
        if (!snapshot.exists || Number(saved.cursor) < delivery.fact.cursor) {
          const input = structuredClone(saved.projection ?? {});
          const projection = reduce(input, delivery);
          call.signal.throwIfAborted();
          await document.update({ subscriptionId: delivery.subscriptionId, cursor: delivery.fact.cursor, projection }, snapshot.document.revision);
        }
        return { subscriptionId: delivery.subscriptionId, deliveryId: delivery.deliveryId, cursor: delivery.fact.cursor };
      });
      tails.set(delivery.subscriptionId, pending);
      void pending.finally(() => {
        if (tails.get(delivery.subscriptionId) === pending)
          tails.delete(delivery.subscriptionId);
      }).catch(() => {
      });
      return pending;
    }
  });
}

// packages/extension-sdk/dist/index.js
var defineHostExtension = (extension) => typeof extension === "function" ? { activate: extension } : extension;

// examples/extensions/run-activity/host.ts
var host_default = defineHostExtension({
  // Fresh extension documents begin at schema 0. Initialize only an empty document; never
  // silently discard an existing projection or pretend to upgrade an unknown format.
  migrate({ data, fromSchemaVersion, toSchemaVersion }) {
    if (fromSchemaVersion !== 0 || toSchemaVersion !== 1 || Object.keys(data).length !== 0) {
      throw new Error("Unsupported activity projection storage format");
    }
    return {};
  },
  activate(context) {
    provideRunActivityProjection(context, (projection, { threadId, fact }) => ({
      ...projection,
      [fact.subject]: {
        threadId,
        runId: fact.subject,
        cursor: fact.cursor,
        revision: fact.revision,
        event: fact.kind,
        state: fact.data.state ?? (fact.kind === "run.accepted" ? "accepted" : "cancel_requested")
      }
    }));
  }
});
