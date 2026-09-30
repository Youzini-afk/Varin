import React from 'react';
import { PiChatView } from '@/components/pi-session/PiChatView';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

type ChatViewProps = {
    active?: boolean;
    readOnly?: boolean;
    autoOpenDraft?: boolean;
    conversationHeader?: React.ReactNode;
    threadPanelMode?: 'sidebar' | 'inline';
    threadPanelTitle?: string;
    showWorkingDirectory?: boolean;
};

export const ChatView: React.FC<ChatViewProps> = ({
    active = true,
    readOnly = false,
    autoOpenDraft = true,
    conversationHeader,
    threadPanelMode,
    threadPanelTitle,
    showWorkingDirectory,
}) => {
    const currentSessionId = usePiSessionStore((state) => state.currentSessionId);

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <PiChatView active={active} readOnly={readOnly} autoOpenDraft={autoOpenDraft}
                conversationHeader={conversationHeader} threadPanelMode={threadPanelMode} threadPanelTitle={threadPanelTitle}
                showWorkingDirectory={showWorkingDirectory} />
        </ChatErrorBoundary>
    );
};
