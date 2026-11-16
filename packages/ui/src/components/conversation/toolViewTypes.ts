import type React from 'react';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import type { ToolDisplayStatus } from './toolInvocation';

export interface ToolViewProps {
  call: ChatToolCall;
  execution?: ChatToolExecutionState;
  result?: ChatToolResultMessage;
  status: ToolDisplayStatus;
  generating?: boolean;
  cwd: string;
  output: React.ReactNode;
  details: React.ReactNode;
}
