import React from 'react';
import { ResourceFilesView } from '@/components/views/ResourceFilesView';
import { useBotPanel } from './botPanelModel';
import { useBotWorkspaceNavigation, type BotWorkspaceView } from './botWorkspaceViews';
export function BotFilesView(props: { view: Extract<BotWorkspaceView, { kind: 'files' }>; active: boolean; setCloseGuard(guard: (() => boolean) | null): void }) {
  const model = useBotPanel(), navigation = useBotWorkspaceNavigation();
  return <ResourceFilesView {...props} workItems={model.workItems} navigation={navigation} />;
}
