import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ChatView } from '@/components/views/ChatView';
import { ThreadResearch } from '@/components/thread/ThreadResearch';
import { useThreadStore } from '@/stores/useThreadStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

function ResearchOverview() {
  const api = useRuntimeAPIs().threads;
  const identity = useThreadStore(state => state.selectedIdentity);
  return identity && api?.research ? <ThreadResearch api={api.research} materials={api.materials} identity={identity} /> : null;
}
const renderConversation = (active: boolean) => <ChatView active={active} conversationHeader={<ResearchOverview />} />;
/** Shell selection never creates execution or changes the selected Thread's source. */
export const ResearchWorkbenchShell: React.FC<Record<string, unknown>> = () => <MainLayout renderConversation={renderConversation} />;
