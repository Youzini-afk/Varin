// Generated from kernel/protocol/schema.json. Do not hand-edit.
import type { ExecutionError, LaunchTool } from './nested-tools.generated.js';
import type { ModelConversationItem, ModelContent, ModelOpaqueItem, ModelToolCompletion, ModelUsageReceipt, FinishReason } from './model-protocol.generated.js';

export interface DriverWaitInput {after:number|null;work:DriverReceiptInput[]}

export interface DriverWaitReceipt {cursor:number;inputPending:boolean;receipts:DriverReceipt[]}

export type DriverContextInput = Record<string,never>;

export interface DriverContextReceipt {history:ModelConversationItem[];tools:LaunchTool[];inputIds:string[];activating:boolean}

export interface DriverCancelInput {kind:'model'|'tool';id:string}

export interface DriverCancelReceipt {requested:boolean;receipt:DriverReceipt|null}

export type DriverRecovery = 'none' | 'checkpoint';

export interface DriverModelInput {id:string;capabilityId:string|null;history:ModelConversationItem[];instructions:string[];tools:string[]}

export interface DriverModelFailure {code:string;message:string;tool_name?:string|null;retry_after_ms:number|null;provider_request_id:string|null}

export interface DriverModelItem {id:string;content:ModelContent;opaque:ModelOpaqueItem|null}

export interface DriverModelReceipt {id:string;requestId:string;outcome:'completed'|'interrupted'|'failed'|'cancelled';items:DriverModelItem[];usage:ModelUsageReceipt;finishReason:FinishReason|null;failure:DriverModelFailure|null}

export interface DriverToolInput {id:string;name:string;arguments:unknown}

export interface DriverToolReceipt {id:string;operationId:string;completion:ModelToolCompletion;executorStopped:boolean}

export interface DriverCheckpointInput {expectedRevision:number;schema:string;state:unknown;operations:string[]}

export interface DriverCheckpoint {revision:number;schema:string;state:unknown;operations:string[]}

export interface DriverDeliveryInput {id:string;text:string}

export interface DriverDeliveryReceipt {id:string;historyId:string}

export interface DriverReceiptInput {id:string;kind:'model'|'tool'|'delivery'}

export type DriverReceipt = {kind:'model';id:string;requestId:string;state:'prepared'|'dispatched'|'completed'|'not_dispatched'|'interrupted'|'failed'|'cancelled';receipt:DriverModelReceipt|null} | {kind:'tool';id:string;operationId:string;phase:'accepted'|'queued'|'preparing'|'running'|'waiting'|'terminal'|null;receipt:DriverToolReceipt|null} | {kind:'delivery';id:string;historyId:string};

export interface DriverRunInput {runId:string;epoch:number;mode:'start'|'resume';history:ModelConversationItem[];tools:LaunchTool[];models:Array<{capabilityId:string;status:'available'|'disabled'|'unconfigured'|'invalid'|'unavailable'}>;checkpoint:DriverCheckpoint|null;receipts:DriverReceipt[]}

export type DriverRunOutcome = {kind:'complete'} | {kind:'pause';reason:string} | {kind:'fail';error:ExecutionError};
