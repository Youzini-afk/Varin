import React from 'react';
import type { ChatTextSource } from './chatSelection';
/** Explicit provenance is required before interpreting assistant-only interactive fences. */
export const ChatTextSourceContext = React.createContext<(ChatTextSource & { role?: string; contentIdentity?: string }) | null>(null);
