import type React from 'react';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';

export interface ToolViewProps {
  call: ChatToolCall;
  execution?: ChatToolExecutionState;
  result?: ChatToolResultMessage;
  status: ChatToolExecutionState['status'];
  generating?: boolean;
  cwd: string;
  output: React.ReactNode;
  details: React.ReactNode;
}
